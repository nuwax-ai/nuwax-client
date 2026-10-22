package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/gorilla/websocket"
)

type pseudoTerminal interface {
	io.ReadWriteCloser
	resize(columns, rows int) error
}

type ptyFactory func(command []string, cwd string, columns, rows int) (pseudoTerminal, error)

type terminalServer struct {
	opt      options
	open     ptyFactory
	mu       sync.Mutex
	closed   bool
	sessions map[*terminalSession]struct{}
}

func newTerminalServer(opt options, open ptyFactory) *terminalServer {
	return &terminalServer{opt: opt, open: open, sessions: make(map[*terminalSession]struct{})}
}

func (server *terminalServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != "/ws" {
		http.NotFound(w, r)
		return
	}
	if !slices.Contains(websocket.Subprotocols(r), "tty") {
		http.Error(w, "expected tty WebSocket subprotocol", http.StatusBadRequest)
		return
	}
	command := slices.Clone(server.opt.command)
	if args := r.URL.Query()["arg"]; server.opt.passArgs && len(args) > 0 {
		// 只接收现有 gateway 注入的目录参数，不能透传额外 shell 选项。
		if len(args) != 2 || args[0] != "--cwd" || !filepath.IsAbs(args[1]) {
			http.Error(w, "expected absolute --cwd argument", http.StatusBadRequest)
			return
		}
		if info, err := os.Stat(args[1]); err != nil || !info.IsDir() {
			http.Error(w, "working directory is unavailable", http.StatusBadRequest)
			return
		}
		command = append(command, args...)
	}
	// 与既有 ttyd 一样，Origin 接受策略由现有回环 gateway/业务入口处理。
	upgrader := websocket.Upgrader{Subprotocols: []string{"tty"}, CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	session := newTerminalSession(conn)
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		session.close()
		return
	}
	server.sessions[session] = struct{}{}
	server.mu.Unlock()
	defer func() {
		session.close()
		server.mu.Lock()
		delete(server.sessions, session)
		server.mu.Unlock()
	}()
	if err := session.serve(server.open, command, server.opt.cwd); err != nil && !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) && !errors.Is(err, io.EOF) {
		// 不输出命令参数和环境变量，避免带出会话信息。
		fmt.Fprintf(os.Stderr, "[legacy-terminal] session ended: %v\n", err)
	}
}

func (server *terminalServer) close() {
	server.mu.Lock()
	server.closed = true
	sessions := make([]*terminalSession, 0, len(server.sessions))
	for session := range server.sessions {
		sessions = append(sessions, session)
	}
	server.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}
