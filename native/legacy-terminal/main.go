package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const version = "ttyd version 1.7.7 (Nuwax WinPTY compatibility 1.0.0)"

type options struct {
	port     int
	host     string
	cwd      string
	passArgs bool
	command  []string
}

func run(args []string) error {
	flags := flag.NewFlagSet("ttyd-legacy", flag.ContinueOnError)
	opt := options{}
	var writable, showVersion bool
	flags.IntVar(&opt.port, "p", 0, "loopback port")
	flags.StringVar(&opt.host, "i", "127.0.0.1", "loopback interface")
	flags.StringVar(&opt.cwd, "w", "", "initial working directory")
	flags.BoolVar(&opt.passArgs, "a", false, "allow per-connection --cwd arguments")
	flags.BoolVar(&writable, "W", false, "allow terminal input")
	flags.BoolVar(&showVersion, "version", false, "show version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if showVersion {
		if err := validateBackend(); err != nil {
			return err
		}
		fmt.Println(version)
		return nil
	}
	opt.command = flags.Args()
	if opt.host != "127.0.0.1" || opt.port < 1 || opt.port > 65535 || !writable || len(opt.command) == 0 {
		return errors.New("expected -i 127.0.0.1 -p <port> -W [-w <cwd>] [-a] <shell> [args]")
	}
	if err := validateBackend(); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort(opt.host, strconv.Itoa(opt.port)))
	if err != nil {
		return err
	}
	terminal := newTerminalServer(opt, openPTY)
	defer terminal.close()
	server := &http.Server{Handler: terminal, ReadHeaderTimeout: 5 * time.Second}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)
	go func() {
		<-interrupt
		terminal.close()
		_ = server.Close()
	}()
	log.Printf("%s listening on %s", version, listener.Addr())
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
