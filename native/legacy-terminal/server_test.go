package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

type fakePTY struct {
	reader *io.PipeReader
	writer *io.PipeWriter
	input  chan string
	sizes  chan dimensions
	closed chan struct{}
	once   sync.Once
}

func newFakePTY() *fakePTY {
	r, w := io.Pipe()
	return &fakePTY{r, w, make(chan string, 4), make(chan dimensions, 4), make(chan struct{}), sync.Once{}}
}
func (pty *fakePTY) Read(data []byte) (int, error) { return pty.reader.Read(data) }
func (pty *fakePTY) Write(data []byte) (int, error) {
	pty.input <- string(data)
	return len(data), nil
}
func (pty *fakePTY) resize(columns, rows int) error {
	pty.sizes <- dimensions{columns, rows}
	return nil
}
func (pty *fakePTY) Close() error {
	pty.once.Do(func() {
		close(pty.closed)
		_ = pty.reader.Close()
		_ = pty.writer.Close()
	})
	return nil
}

func testServer(t *testing.T, open ptyFactory) (*terminalServer, string) {
	t.Helper()
	terminal := newTerminalServer(options{command: []string{"shell.exe", "-File", "wrapper.ps1"}, cwd: t.TempDir(), passArgs: true}, open)
	httpServer := httptest.NewServer(terminal)
	t.Cleanup(func() { terminal.close(); httpServer.Close() })
	return terminal, "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
}

func connect(t *testing.T, address string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: []string{"tty"}}
	conn, _, err := dialer.Dial(address, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	return conn
}

func send(t *testing.T, conn *websocket.Conn, data string) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(data)); err != nil {
		t.Fatal(err)
	}
}

func receive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for terminal event")
		var zero T
		return zero
	}
}

func TestWireInputResizeAndFragmentedChineseOutput(t *testing.T) {
	pty := newFakePTY()
	started := make(chan dimensions, 1)
	_, address := testServer(t, func(command []string, cwd string, columns, rows int) (pseudoTerminal, error) {
		started <- dimensions{columns, rows}
		return pty, nil
	})
	conn := connect(t, address)
	send(t, conn, `{"columns":100,"rows":32}`)
	if size := receive(t, started); size != (dimensions{100, 32}) {
		t.Fatal(size)
	}
	send(t, conn, "0中文输入\r\x03")
	if input := receive(t, pty.input); input != "中文输入\r\x03" {
		t.Fatalf("input changed: %q", input)
	}
	send(t, conn, `1{"columns":132,"rows":45}`)
	if size := receive(t, pty.sizes); size != (dimensions{132, 45}) {
		t.Fatal(size)
	}
	go func() {
		for _, value := range []byte("中文回显> ") {
			_, _ = pty.writer.Write([]byte{value})
		}
	}()
	var output string
	for len(output) < len("中文回显> ") {
		kind, data, err := conn.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || len(data) < 2 || data[0] != '0' || !utf8.Valid(data[1:]) {
			t.Fatalf("invalid output: type=%d data=%q err=%v", kind, data, err)
		}
		output += string(data[1:])
	}
	if output != "中文回显> " {
		t.Fatal(output)
	}
	_ = conn.Close()
	receive(t, pty.closed)
}

func TestTwoConnectionsKeepArgumentsAndLifetimeIndependent(t *testing.T) {
	type opened struct {
		command []string
		pty     *fakePTY
	}
	created := make(chan opened, 2)
	_, address := testServer(t, func(command []string, _ string, _, _ int) (pseudoTerminal, error) {
		pty := newFakePTY()
		created <- opened{command, pty}
		return pty, nil
	})
	dirs := []string{t.TempDir(), t.TempDir()}
	connections := make([]*websocket.Conn, 2)
	terminals := make([]*fakePTY, 2)
	for i, dir := range dirs {
		connections[i] = connect(t, address+"?arg=--cwd&arg="+url.QueryEscape(dir))
		send(t, connections[i], `{"columns":80,"rows":24}`)
		result := receive(t, created)
		if result.command[len(result.command)-1] != dir || result.command[len(result.command)-2] != "--cwd" {
			t.Fatal(result.command)
		}
		terminals[i] = result.pty
	}
	_ = connections[0].Close()
	receive(t, terminals[0].closed)
	send(t, connections[1], "0still running\r")
	if value := receive(t, terminals[1].input); value != "still running\r" {
		t.Fatal(value)
	}
}

func TestPauseResumeAndClosingPausedSession(t *testing.T) {
	pty := newFakePTY()
	_, address := testServer(t, func([]string, string, int, int) (pseudoTerminal, error) { return pty, nil })
	conn := connect(t, address)
	send(t, conn, `{"columns":80,"rows":24}`)
	send(t, conn, "2")
	// resize 是同一 reader 中的屏障，收到后 PAUSE 已处理。
	send(t, conn, `1{"columns":81,"rows":25}`)
	receive(t, pty.sizes)
	messages := make(chan string, 1)
	go func() {
		_, data, _ := conn.ReadMessage()
		messages <- string(data)
	}()
	go func() { _, _ = pty.writer.Write([]byte("paused output")) }()
	select {
	case message := <-messages:
		t.Fatalf("output sent while paused: %q", message)
	case <-time.After(50 * time.Millisecond):
	}
	send(t, conn, "3")
	if message := receive(t, messages); message != "0paused output" {
		t.Fatal(message)
	}
	send(t, conn, "2")
	_ = conn.Close()
	receive(t, pty.closed)
}

func TestBackendFailureClosesWithError(t *testing.T) {
	_, address := testServer(t, func([]string, string, int, int) (pseudoTerminal, error) { return nil, errors.New("missing DLL") })
	conn := connect(t, address)
	send(t, conn, `{"columns":80,"rows":24}`)
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseInternalServerErr) {
		t.Fatal(err)
	}
}

func TestHealthHandshakeDoesNotSpawnShellAndInvalidInitCannotSpawn(t *testing.T) {
	var count atomic.Int32
	_, address := testServer(t, func([]string, string, int, int) (pseudoTerminal, error) {
		count.Add(1)
		return newFakePTY(), nil
	})
	conn := connect(t, address)
	_ = conn.Close()
	for _, data := range []string{`{"columns":0,"rows":24}`, `{"columns":80,"rows":5001}`, "0input before init"} {
		conn := connect(t, address)
		send(t, conn, data)
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Fatal("expected connection close")
		}
	}
	if count.Load() != 0 {
		t.Fatal("invalid/health connection spawned a shell")
	}
}

func TestRejectsExtraShellArgumentsBeforeUpgrade(t *testing.T) {
	_, address := testServer(t, nil)
	for _, query := range []string{"arg=-Command&arg=bad", "arg=--cwd&arg=relative", "arg=--cwd&arg=" + url.QueryEscape(os.TempDir()) + "&arg=extra"} {
		_, response, err := (&websocket.Dialer{Subprotocols: []string{"tty"}}).Dial(address+"?"+query, nil)
		if err == nil || response == nil || response.StatusCode != http.StatusBadRequest {
			t.Fatalf("accepted invalid args: %s %v", query, err)
		}
		_ = response.Body.Close()
	}
}

func TestServerCloseTerminatesAllPTYs(t *testing.T) {
	created := make(chan *fakePTY, 1)
	server, address := testServer(t, func([]string, string, int, int) (pseudoTerminal, error) {
		pty := newFakePTY()
		created <- pty
		return pty, nil
	})
	conn := connect(t, address)
	send(t, conn, `{"columns":80,"rows":24}`)
	pty := receive(t, created)
	// factory 返回与 session 安装之间也可能发生关闭。
	server.close()
	receive(t, pty.closed)
}

func TestBareShellFallbackIgnoresURLArgumentsLikeNativeTtyd(t *testing.T) {
	created := make(chan []string, 1)
	server, address := testServer(t, func(command []string, _ string, _, _ int) (pseudoTerminal, error) {
		created <- command
		return newFakePTY(), nil
	})
	server.opt.passArgs = false
	conn := connect(t, address+"?arg=--cwd&arg=ignored")
	send(t, conn, `{"columns":80,"rows":24}`)
	if command := receive(t, created); len(command) != 3 {
		t.Fatalf("bare shell received URL arguments: %v", command)
	}
}
