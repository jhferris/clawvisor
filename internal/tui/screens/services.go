package screens

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/clawvisor/clawvisor/internal/tui"
	"github.com/clawvisor/clawvisor/internal/tui/client"
)

// ── Messages ────────────────────────────────────────────────────────────────

type servicesDataMsg struct {
	services []client.ServiceInfo
}

// ── Model ───────────────────────────────────────────────────────────────────

type ServicesScreen struct {
	client   *client.Client
	services []client.ServiceInfo
	cursor   int
	width    int
	height   int
	loading  bool
	err      error
	detail   Detail
}

func NewServicesScreen(c *client.Client) *ServicesScreen {
	return &ServicesScreen{
		client: c,
		detail: NewDetail(),
	}
}

func (s *ServicesScreen) Init() tea.Cmd {
	s.loading = true
	return s.fetchServices()
}

func (s *ServicesScreen) Update(msg tea.Msg) (tui.ScreenModel, tea.Cmd) {
	var cmds []tea.Cmd

	if s.detail.Visible() {
		d, cmd := s.detail.Update(msg)
		s.detail = d
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		if _, isKey := msg.(tea.KeyMsg); isKey {
			return s, tea.Batch(cmds...)
		}
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.width = msg.Width
		s.height = msg.Height
		s.detail = s.detail.SetSize(msg.Width, msg.Height)

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, tui.ListNavKeys.Up):
			if s.cursor > 0 {
				s.cursor--
			}
		case key.Matches(msg, tui.ListNavKeys.Down):
			if s.cursor < len(s.services)-1 {
				s.cursor++
			}
		case key.Matches(msg, tui.ListNavKeys.Enter):
			s.showDetail()
		case key.Matches(msg, tui.Keys.Refresh):
			return s, s.fetchServices()
		}

	case tui.TickMsg:
		return s, s.fetchServices()

	case servicesDataMsg:
		s.loading = false
		s.services = msg.services
		if s.cursor >= len(s.services) {
			s.cursor = max(0, len(s.services)-1)
		}

	case tui.ErrMsg:
		s.err = msg.Err
		s.loading = false
	}

	return s, tea.Batch(cmds...)
}

func (s *ServicesScreen) View() string {
	if s.detail.Visible() {
		return s.detail.View()
	}

	var b strings.Builder

	header := lipgloss.NewStyle().Foreground(tui.ColorWhite).Bold(true)
	b.WriteString(header.Render("SERVICES"))
	b.WriteString("\n")
	b.WriteString(tui.StyleDim.Render(strings.Repeat("─", min(60, s.contentWidth()))))
	b.WriteString("\n\n")

	if s.err != nil {
		b.WriteString(tui.StyleRed.Render("Error: " + s.err.Error()) + "\n")
	}

	if s.loading && len(s.services) == 0 {
		b.WriteString(tui.StyleDim.Render("  Loading..."))
		return b.String()
	}

	if len(s.services) == 0 {
		b.WriteString(tui.StyleDim.Render("  No services configured."))
		return b.String()
	}

	// Split by status.
	var connected, available []indexedService
	for i, svc := range s.services {
		is := indexedService{svc: svc, idx: i}
		if svc.Status == "activated" {
			connected = append(connected, is)
		} else {
			available = append(available, is)
		}
	}

	if len(connected) > 0 {
		b.WriteString(tui.StyleBold.Render("CONNECTED") + "\n")
		for _, is := range connected {
			sel := is.idx == s.cursor
			b.WriteString(s.renderService(is.svc, sel, true))
		}
		b.WriteString("\n")
	}

	if len(available) > 0 {
		b.WriteString(tui.StyleDim.Render("AVAILABLE (not connected)") + "\n")
		for _, is := range available {
			sel := is.idx == s.cursor
			b.WriteString(s.renderService(is.svc, sel, false))
		}
	}

	return b.String()
}

func (s *ServicesScreen) ShortHelp() []string {
	return []string{
		tui.StyleStatusKey.Render("[enter]") + tui.StyleStatusBar.Render(" Details"),
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

type indexedService struct {
	svc client.ServiceInfo
	idx int
}

func (s *ServicesScreen) renderService(svc client.ServiceInfo, selected, connected bool) string {
	marker := "  "
	if selected {
		marker = tui.StyleBrand.Render("> ")
	}

	icon := tui.StyleDim.Render("○")
	if connected {
		icon = tui.StyleGreen.Render("●")
	}

	name := svc.ID
	if svc.Alias != "" {
		name = svc.ID + ":" + svc.Alias
	}

	colName := lipgloss.NewStyle().Width(28)
	colDesc := lipgloss.NewStyle().Width(24)

	status := ""
	if connected {
		status = tui.StyleGreen.Render("✓ healthy")
	}

	line := marker + icon + " " +
		colName.Render(name) +
		colDesc.Render(svc.Name) +
		status

	return line + "\n"
}

// ── Actions ─────────────────────────────────────────────────────────────────

func (s *ServicesScreen) fetchServices() tea.Cmd {
	c := s.client
	return func() tea.Msg {
		resp, err := c.GetServices()
		if err != nil {
			return tui.ErrMsg{Err: err}
		}
		return servicesDataMsg{services: resp.Services}
	}
}

func (s *ServicesScreen) showDetail() {
	if s.cursor >= len(s.services) {
		return
	}
	svc := s.services[s.cursor]

	var b strings.Builder
	b.WriteString(tui.StyleDim.Render("ID:          ") + svc.ID + "\n")
	b.WriteString(tui.StyleDim.Render("Name:        ") + svc.Name + "\n")
	b.WriteString(tui.StyleDim.Render("Description: ") + svc.Description + "\n")
	b.WriteString(tui.StyleDim.Render("Status:      ") + svc.Status + "\n")
	b.WriteString(tui.StyleDim.Render("OAuth:       "))
	if svc.OAuth {
		b.WriteString("Yes")
	} else {
		b.WriteString("No (API key)")
	}
	b.WriteString("\n")

	if svc.ActivatedAt != "" {
		b.WriteString(tui.StyleDim.Render("Activated:   ") + svc.ActivatedAt + "\n")
	}

	if len(svc.Actions) > 0 {
		b.WriteString("\n" + tui.StyleBold.Render("Available Actions") + "\n")
		for _, a := range svc.Actions {
			b.WriteString("  " + a + "\n")
		}
	}

	s.detail.Show("Service: "+svc.Name, b.String())
}

func (s *ServicesScreen) contentWidth() int {
	w := s.width - 26
	if w < 40 {
		w = 40
	}
	return w
}
