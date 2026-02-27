package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// TickMsg is sent every poll interval to trigger data refresh.
type TickMsg time.Time

// PollTick returns a tea.Cmd that waits for the given duration then sends a TickMsg.
func PollTick(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(t time.Time) tea.Msg {
		return TickMsg(t)
	})
}

// ErrMsg carries an error from an async operation.
type ErrMsg struct{ Err error }

func (e ErrMsg) Error() string { return e.Err.Error() }

// StatusMsg is displayed briefly in the status bar.
type StatusMsg string

// ScreenSwitchMsg requests switching to a different screen.
type ScreenSwitchMsg struct{ Screen Screen }
