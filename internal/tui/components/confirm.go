package components

import (
	"fmt"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/clawvisor/clawvisor/internal/tui"
)

// ConfirmResult is sent when the user responds to a confirmation dialog.
type ConfirmResult struct {
	Confirmed bool
	Tag       string // identifies which confirmation this is
}

// Confirm is a simple y/n confirmation overlay.
type Confirm struct {
	Title   string
	Message string
	Tag     string
	width   int
}

func NewConfirm(title, message, tag string) Confirm {
	return Confirm{Title: title, Message: message, Tag: tag}
}

func (c Confirm) Init() tea.Cmd { return nil }

func (c Confirm) Update(msg tea.Msg) (Confirm, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch {
		case key.Matches(msg, key.NewBinding(key.WithKeys("y", "Y"))):
			return c, func() tea.Msg { return ConfirmResult{Confirmed: true, Tag: c.Tag} }
		case key.Matches(msg, key.NewBinding(key.WithKeys("n", "N", "esc"))):
			return c, func() tea.Msg { return ConfirmResult{Confirmed: false, Tag: c.Tag} }
		}
	case tea.WindowSizeMsg:
		c.width = msg.Width
	}
	return c, nil
}

func (c Confirm) View() string {
	w := c.width
	if w <= 0 {
		w = 50
	}
	if w > 60 {
		w = 60
	}

	title := lipgloss.NewStyle().
		Foreground(tui.ColorAccent).
		Bold(true).
		Render(c.Title)

	msg := lipgloss.NewStyle().
		Foreground(tui.ColorWhite).
		Render(c.Message)

	hint := lipgloss.NewStyle().
		Foreground(tui.ColorDim).
		Render("[y] Yes  [n] No")

	content := fmt.Sprintf("%s\n\n%s\n\n%s", title, msg, hint)

	return tui.StyleOverlayBorder.
		Width(w).
		Render(content)
}
