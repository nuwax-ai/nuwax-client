//go:build !windows

package main

import "errors"

func validateBackend() error { return errors.New("WinPTY requires Windows") }

func openPTY([]string, string, int, int) (pseudoTerminal, error) {
	return nil, validateBackend()
}
