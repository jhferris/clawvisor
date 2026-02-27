package screens

import (
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/clawvisor/clawvisor/internal/tui"
)

// Detail is a viewport-based overlay for showing item details.
type Detail struct {
	viewport viewport.Model
	title    string
	visible  bool
	width    int
	height   int
}

func NewDetail() Detail {
	return Detail{}
}

func (d *Detail) Show(title, content string) {
	d.title = title
	d.visible = true
	d.viewport = viewport.New(d.contentWidth(), d.contentHeight())
	d.viewport.SetContent(content)
}

func (d *Detail) Hide() {
	d.visible = false
}

func (d Detail) Visible() bool {
	return d.visible
}

func (d Detail) Update(msg tea.Msg) (Detail, tea.Cmd) {
	if !d.visible {
		return d, nil
	}
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if key.Matches(msg, key.NewBinding(key.WithKeys("esc", "q"))) {
			d.visible = false
			return d, nil
		}
	case tea.WindowSizeMsg:
		d.width = msg.Width
		d.height = msg.Height
		d.viewport.Width = d.contentWidth()
		d.viewport.Height = d.contentHeight()
	}
	var cmd tea.Cmd
	d.viewport, cmd = d.viewport.Update(msg)
	return d, cmd
}

func (d Detail) View() string {
	if !d.visible {
		return ""
	}

	titleStyle := lipgloss.NewStyle().
		Foreground(tui.ColorBrand).
		Bold(true)

	header := titleStyle.Render(d.title)
	hint := tui.StyleDim.Render("[esc] Close  [up/down] Scroll")

	content := header + "\n\n" + d.viewport.View() + "\n" + hint

	return tui.StyleOverlayBorder.
		Width(d.overlayWidth()).
		Render(content)
}

func (d Detail) SetSize(w, h int) Detail {
	d.width = w
	d.height = h
	d.viewport.Width = d.contentWidth()
	d.viewport.Height = d.contentHeight()
	return d
}

func (d Detail) overlayWidth() int {
	w := d.width - 8
	if w < 40 {
		w = 40
	}
	if w > 100 {
		w = 100
	}
	return w
}

func (d Detail) contentWidth() int {
	return d.overlayWidth() - 6 // border + padding
}

func (d Detail) contentHeight() int {
	h := d.height - 10
	if h < 10 {
		h = 10
	}
	return h
}
