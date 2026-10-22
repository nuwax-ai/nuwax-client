package main

import (
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

type dimensions struct {
	Columns int `json:"columns"`
	Rows    int `json:"rows"`
}

func parseDimensions(data []byte) (dimensions, error) {
	var size dimensions
	if err := json.Unmarshal(data, &size); err != nil {
		return size, err
	}
	if size.Columns < 1 || size.Columns > 5000 || size.Rows < 1 || size.Rows > 5000 {
		return size, errors.New("terminal dimensions must be between 1 and 5000")
	}
	return size, nil
}

type terminalSession struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	flow    *sync.Cond
	paused  bool
	closed  bool
	pty     pseudoTerminal
	closing sync.Once
}

func newTerminalSession(conn *websocket.Conn) *terminalSession {
	session := &terminalSession{conn: conn}
	session.flow = sync.NewCond(&session.mu)
	return session
}

func (session *terminalSession) close() {
	session.closing.Do(func() {
		session.mu.Lock()
		session.closed = true
		pty := session.pty
		session.flow.Broadcast()
		session.mu.Unlock()
		_ = session.conn.Close()
		if pty != nil {
			_ = pty.Close()
		}
	})
}

func (session *terminalSession) serve(open ptyFactory, command []string, cwd string) error {
	session.conn.SetReadLimit(1024 * 1024)
	// 首包之前尚无 shell，避免闲置握手长期占用连接。
	_ = session.conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		_, data, err := session.conn.ReadMessage()
		if err != nil {
			return err
		}
		if len(data) == 0 {
			continue
		}
		if session.pty == nil {
			if data[0] != '{' {
				return errors.New("expected terminal initialization JSON")
			}
			size, err := parseDimensions(data)
			if err != nil {
				return err
			}
			pty, err := open(command, cwd, size.Columns, size.Rows)
			if err != nil {
				_ = session.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "terminal backend failed"), time.Now().Add(time.Second))
				return err
			}
			session.mu.Lock()
			if session.closed {
				session.mu.Unlock()
				_ = pty.Close()
				return io.EOF
			}
			session.pty = pty
			session.mu.Unlock()
			_ = session.conn.SetReadDeadline(time.Time{})
			go session.output(pty)
			continue
		}
		switch data[0] {
		case '0':
			if _, err := session.pty.Write(data[1:]); err != nil {
				return err
			}
		case '1':
			size, err := parseDimensions(data[1:])
			if err != nil {
				return err
			}
			if err := session.pty.resize(size.Columns, size.Rows); err != nil {
				return err
			}
		case '2', '3':
			session.mu.Lock()
			session.paused = data[0] == '2'
			session.flow.Broadcast()
			session.mu.Unlock()
		default:
			return errors.New("unknown terminal frame")
		}
	}
}

// 前端逐帧 TextDecoder，输出不能在 UTF-8 字符中间截断。
func completeUTF8(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	start := len(data) - 1
	for start > 0 && !utf8.RuneStart(data[start]) {
		start--
	}
	if !utf8.FullRune(data[start:]) {
		return start
	}
	return len(data)
}

func (session *terminalSession) output(pty pseudoTerminal) {
	defer session.close()
	buffer := make([]byte, 16384)
	pending := make([]byte, 0, len(buffer)+utf8.UTFMax)
	for {
		session.mu.Lock()
		for session.paused && !session.closed {
			session.flow.Wait()
		}
		closed := session.closed
		session.mu.Unlock()
		if closed {
			return
		}
		n, err := pty.Read(buffer)
		pending = append(pending, buffer[:n]...)
		end := completeUTF8(pending)
		if err != nil {
			end = len(pending)
		}
		if end > 0 {
			// PAUSE 也可能在 Read 阻塞期间到达；发送前再次检查，最多缓存一块输出。
			session.mu.Lock()
			for session.paused && !session.closed {
				session.flow.Wait()
			}
			closed := session.closed
			session.mu.Unlock()
			if closed {
				return
			}
			frame := append([]byte{'0'}, pending[:end]...)
			_ = session.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if writeErr := session.conn.WriteMessage(websocket.BinaryMessage, frame); writeErr != nil {
				return
			}
			pending = append(pending[:0], pending[end:]...)
		}
		if err != nil {
			_ = session.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "terminal exited"), time.Now().Add(time.Second))
			return
		}
	}
}
