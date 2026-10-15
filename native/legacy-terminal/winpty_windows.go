package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

type winptyAPI struct {
	dll   *syscall.DLL
	procs map[string]*syscall.Proc
}

const (
	spawnAutoShutdown          = 1
	spawnExitAfterShutdown     = 2
	jobObjectKillOnClose       = 0x2000
	jobObjectExtendedLimitInfo = 9
)

var backend struct {
	sync.Once
	api *winptyAPI
	err error
}

func loadWinPTY() (*winptyAPI, error) {
	backend.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			backend.err = err
			return
		}
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, "winpty-agent.exe")); err != nil {
			backend.err = fmt.Errorf("WinPTY agent unavailable: %w", err)
			return
		}
		dll, err := syscall.LoadDLL(filepath.Join(dir, "winpty.dll"))
		if err != nil {
			backend.err = fmt.Errorf("load WinPTY: %w", err)
			return
		}
		api := &winptyAPI{dll: dll, procs: make(map[string]*syscall.Proc)}
		for _, name := range []string{
			"winpty_config_new", "winpty_config_free", "winpty_config_set_initial_size", "winpty_config_set_agent_timeout",
			"winpty_open", "winpty_free", "winpty_agent_process", "winpty_conin_name", "winpty_conout_name",
			"winpty_spawn_config_new", "winpty_spawn_config_free", "winpty_spawn", "winpty_set_size",
			"winpty_error_msg", "winpty_error_free",
		} {
			proc, err := dll.FindProc(name)
			if err != nil {
				_ = dll.Release()
				backend.err = err
				return
			}
			api.procs[name] = proc
		}
		backend.api = api
	})
	return backend.api, backend.err
}

func validateBackend() error {
	_, err := loadWinPTY()
	return err
}

// 指针参数必须逃逸并存活到 DLL 调用结束，不能只保留临时 uintptr。
//
//go:uintptrescapes
func (api *winptyAPI) call(name string, args ...uintptr) uintptr {
	value, _, _ := api.procs[name].Call(args...)
	return value
}

func (api *winptyAPI) error(operation string, pointer uintptr) error {
	if pointer == 0 {
		return fmt.Errorf("%s failed", operation)
	}
	defer api.call("winpty_error_free", pointer)
	message := wideString(api.call("winpty_error_msg", pointer))
	return fmt.Errorf("%s: %s", operation, message)
}

func wideString(pointer uintptr) string {
	if pointer == 0 {
		return ""
	}
	// 指针由已加载的 DLL 拥有，仅在对象存活期间复制。
	var text []uint16
	for i := uintptr(0); ; i++ {
		value := *(*uint16)(unsafe.Pointer(pointer + i*2))
		if value == 0 {
			break
		}
		text = append(text, value)
	}
	return syscall.UTF16ToString(text)
}

type winPTY struct {
	api     *winptyAPI
	mu      sync.Mutex
	pointer uintptr
	job     syscall.Handle
	child   syscall.Handle
	in      *os.File
	out     *os.File
}

func openPTY(command []string, cwd string, columns, rows int) (pseudoTerminal, error) {
	api, err := loadWinPTY()
	if err != nil {
		return nil, err
	}
	var failure uintptr
	config := api.call("winpty_config_new", 0, uintptr(unsafe.Pointer(&failure)))
	if config == 0 {
		return nil, api.error("configure WinPTY", failure)
	}
	defer api.call("winpty_config_free", config)
	api.call("winpty_config_set_initial_size", config, uintptr(columns), uintptr(rows))
	api.call("winpty_config_set_agent_timeout", config, 5000)
	pointer := api.call("winpty_open", config, uintptr(unsafe.Pointer(&failure)))
	if pointer == 0 {
		return nil, api.error("start WinPTY agent", failure)
	}
	pty := &winPTY{api: api, pointer: pointer}
	ok := false
	defer func() {
		if !ok {
			_ = pty.Close()
		}
	}()
	// 在 shell 启动前把 agent 加入 job，后续所有子进程自动继承，避免断连遗留进程。
	pty.job, err = createTerminalJob(syscall.Handle(api.call("winpty_agent_process", pointer)))
	if err != nil {
		return nil, err
	}
	for _, stream := range []struct {
		name   string
		access uint32
		file   **os.File
	}{
		{"winpty_conin_name", syscall.GENERIC_WRITE, &pty.in},
		{"winpty_conout_name", syscall.GENERIC_READ, &pty.out},
	} {
		pipeName := api.call(stream.name, pointer)
		handle, err := syscall.CreateFile((*uint16)(unsafe.Pointer(pipeName)), stream.access, 0, nil, syscall.OPEN_EXISTING, 0, 0)
		if err != nil {
			return nil, fmt.Errorf("open WinPTY pipe: %w", err)
		}
		*stream.file = os.NewFile(uintptr(handle), stream.name)
	}
	escaped := make([]string, len(command))
	for i, arg := range command {
		escaped[i] = syscall.EscapeArg(arg)
	}
	commandLine, err := syscall.UTF16PtrFromString(strings.Join(escaped, " "))
	if err != nil {
		return nil, err
	}
	var cwdPointer *uint16
	if cwd != "" {
		cwdPointer, err = syscall.UTF16PtrFromString(cwd)
		if err != nil {
			return nil, err
		}
	}
	// AUTO_SHUTDOWN | EXIT_AFTER_SHUTDOWN：进程退出后把剩余输出排空，再关闭 console。
	spawnConfig := api.call("winpty_spawn_config_new", spawnAutoShutdown|spawnExitAfterShutdown, 0, uintptr(unsafe.Pointer(commandLine)), uintptr(unsafe.Pointer(cwdPointer)), 0, uintptr(unsafe.Pointer(&failure)))
	runtime.KeepAlive(commandLine)
	runtime.KeepAlive(cwdPointer)
	if spawnConfig == 0 {
		return nil, api.error("configure terminal process", failure)
	}
	defer api.call("winpty_spawn_config_free", spawnConfig)
	var createError uint32
	if api.call("winpty_spawn", pointer, spawnConfig, uintptr(unsafe.Pointer(&pty.child)), 0, uintptr(unsafe.Pointer(&createError)), uintptr(unsafe.Pointer(&failure))) == 0 {
		return nil, api.error(fmt.Sprintf("spawn terminal process (Windows error %d)", createError), failure)
	}
	ok = true
	return pty, nil
}

func (pty *winPTY) Read(buffer []byte) (int, error)  { return pty.out.Read(buffer) }
func (pty *winPTY) Write(buffer []byte) (int, error) { return pty.in.Write(buffer) }

func (pty *winPTY) resize(columns, rows int) error {
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if pty.pointer == 0 {
		return errors.New("terminal is closed")
	}
	var failure uintptr
	if pty.api.call("winpty_set_size", pty.pointer, uintptr(columns), uintptr(rows), uintptr(unsafe.Pointer(&failure))) == 0 {
		return pty.api.error("resize terminal", failure)
	}
	return nil
}

func (pty *winPTY) Close() error {
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if pty.pointer == 0 {
		return nil
	}
	// 先关闭 job 终止 agent/进程树，使同步 pipe Read/Write 得以返回。
	if pty.job != 0 {
		_ = syscall.CloseHandle(pty.job)
	}
	pty.api.call("winpty_free", pty.pointer)
	pty.pointer = 0
	if pty.in != nil {
		_ = pty.in.Close()
	}
	if pty.out != nil {
		_ = pty.out.Close()
	}
	if pty.child != 0 {
		_ = syscall.CloseHandle(pty.child)
	}
	return nil
}

// Windows x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION；不依赖 Node 原生模块或 C 编译器。
type jobLimits struct {
	ProcessTime, JobTime     int64
	Flags                    uint32
	MinimumSet, MaximumSet   uintptr
	ActiveProcesses          uint32
	Affinity                 uintptr
	Priority, Scheduling     uint32
	IO                       [6]uint64
	ProcessMemory, JobMemory uintptr
	PeakProcess, PeakJob     uintptr
}

func createTerminalJob(agent syscall.Handle) (syscall.Handle, error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	job, _, callErr := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return 0, fmt.Errorf("create terminal job: %w", callErr)
	}
	fail := func(operation string, err error) (syscall.Handle, error) {
		_ = syscall.CloseHandle(syscall.Handle(job))
		return 0, fmt.Errorf("%s: %w", operation, err)
	}
	limits := jobLimits{Flags: jobObjectKillOnClose}
	if ok, _, err := kernel.NewProc("SetInformationJobObject").Call(job, jobObjectExtendedLimitInfo, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		return fail("configure terminal job", err)
	}
	if ok, _, err := kernel.NewProc("AssignProcessToJobObject").Call(job, uintptr(agent)); ok == 0 {
		return fail("assign WinPTY agent to terminal job", err)
	}
	return syscall.Handle(job), nil
}
