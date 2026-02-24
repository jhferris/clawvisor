// Package imessage implements the Clawvisor adapter for Apple iMessage.
// This adapter reads directly from the macOS Messages SQLite database
// (~/Library/Messages/chat.db) and optionally resolves contact names
// from the macOS Contacts database.
//
// Prerequisites:
//   - macOS with Messages.app configured
//   - Full Disk Access permission for the Clawvisor process
//
// The send_message action always requires human approval, regardless of policy.
// Sending is performed via AppleScript; Messages.app must be running.
package imessage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/oauth2"

	_ "modernc.org/sqlite" // registers "sqlite" driver

	"github.com/ericlevine/clawvisor/internal/adapters"
	"github.com/ericlevine/clawvisor/internal/adapters/format"
)

const serviceID = "apple.imessage"

// IMessageAdapter implements adapters.Adapter for Apple iMessage.
type IMessageAdapter struct {
	dbPath string
}

func New() *IMessageAdapter {
	home, _ := os.UserHomeDir()
	return &IMessageAdapter{
		dbPath: filepath.Join(home, "Library", "Messages", "chat.db"),
	}
}

// Available returns true if the adapter can operate on this host.
// Requires macOS with chat.db present.
func (a *IMessageAdapter) Available() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	_, err := os.Stat(a.dbPath)
	return err == nil
}

func (a *IMessageAdapter) ServiceID() string { return serviceID }

func (a *IMessageAdapter) SupportedActions() []string {
	return []string{"search_messages", "list_threads", "get_thread", "send_message"}
}

// OAuthConfig returns nil — iMessage uses local file access, no OAuth.
func (a *IMessageAdapter) OAuthConfig() *oauth2.Config { return nil }

// CredentialFromToken is unused for local services.
func (a *IMessageAdapter) CredentialFromToken(_ *oauth2.Token) ([]byte, error) {
	return nil, fmt.Errorf("imessage: no token exchange — local service")
}

// ValidateCredential accepts any non-nil byte slice (no stored credential needed).
func (a *IMessageAdapter) ValidateCredential(_ []byte) error { return nil }

func (a *IMessageAdapter) Execute(ctx context.Context, req adapters.Request) (*adapters.Result, error) {
	switch req.Action {
	case "search_messages":
		return a.searchMessages(ctx, req.Params)
	case "list_threads":
		return a.listThreads(ctx, req.Params)
	case "get_thread":
		return a.getThread(ctx, req.Params)
	case "send_message":
		return a.sendMessage(ctx, req.Params)
	default:
		return nil, fmt.Errorf("imessage: unsupported action %q", req.Action)
	}
}

// CheckPermissions tries to open chat.db read-only.
// Returns an error with human-readable guidance if access is denied.
func (a *IMessageAdapter) CheckPermissions() error {
	db, err := sql.Open("sqlite", "file:"+a.dbPath+"?mode=ro&immutable=1")
	if err != nil {
		return fmt.Errorf("cannot open chat.db: %w — grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		return fmt.Errorf("cannot read chat.db: %w — grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access", err)
	}
	return nil
}

func (a *IMessageAdapter) openDB() (*sql.DB, error) {
	return sql.Open("sqlite", "file:"+a.dbPath+"?mode=ro&immutable=1")
}

// ── search_messages ───────────────────────────────────────────────────────────

type messageResult struct {
	ID             string `json:"id"`
	From           string `json:"from"`
	FromIdentifier string `json:"from_identifier"`
	Text           string `json:"text"`
	Timestamp      string `json:"timestamp"`
	IsFromMe       bool   `json:"is_from_me"`
	ThreadID       string `json:"thread_id"`
}

func (a *IMessageAdapter) searchMessages(ctx context.Context, params map[string]any) (*adapters.Result, error) {
	query, _ := params["query"].(string)
	if query == "" {
		return nil, fmt.Errorf("imessage search_messages: query is required")
	}
	contact, _ := params["contact"].(string)
	daysBack := 90
	if v, ok := paramInt(params, "days_back"); ok && v > 0 {
		daysBack = v
	}
	maxResults := 20
	if v, ok := paramInt(params, "max_results"); ok && v > 0 && v <= 50 {
		maxResults = v
	}

	db, err := a.openDB()
	if err != nil {
		return nil, fmt.Errorf("imessage: cannot open chat.db: %w", err)
	}
	defer db.Close()

	since := time.Now().Add(-time.Duration(daysBack) * 24 * time.Hour)
	// Apple uses a nanosecond epoch offset from 2001-01-01 (CoreData epoch)
	coredataEpoch := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	sinceApple := since.Sub(coredataEpoch).Nanoseconds()

	var sqlQuery string
	var args []any

	if contact != "" {
		// Resolve contact identifier first
		identifiers, _ := a.resolveContactIdentifiers(db, contact)
		if len(identifiers) == 0 {
			return &adapters.Result{
				Summary: format.Summary("No messages from %q matching %q", contact, query),
				Data:    []messageResult{},
			}, nil
		}
		placeholders := make([]string, len(identifiers))
		for i, id := range identifiers {
			placeholders[i] = "?"
			args = append(args, id)
		}
		args = append(args, "%"+query+"%", sinceApple, maxResults)
		sqlQuery = fmt.Sprintf(`
			SELECT m.ROWID, m.text, m.is_from_me, m.date, h.id, c.chat_identifier
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE h.id IN (%s)
			  AND m.text LIKE ?
			  AND m.date > ?
			  AND m.is_from_me = 0
			ORDER BY m.date DESC
			LIMIT ?`, strings.Join(placeholders, ","))
	} else {
		args = []any{"%" + query + "%", sinceApple, maxResults}
		sqlQuery = `
			SELECT m.ROWID, m.text, m.is_from_me, m.date, COALESCE(h.id, ''), c.chat_identifier
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE m.text LIKE ?
			  AND m.date > ?
			ORDER BY m.date DESC
			LIMIT ?`
	}

	rows, err := db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("imessage search_messages query: %w", err)
	}
	defer rows.Close()

	msgs := a.scanMessages(rows)
	nameMap := a.buildNameMap(db, msgs)
	results := a.formatMessages(msgs, nameMap)

	return &adapters.Result{
		Summary: format.Summary("%d message(s) matching %q", len(results), query),
		Data:    results,
	}, nil
}

// ── list_threads ──────────────────────────────────────────────────────────────

type threadItem struct {
	ThreadID           string `json:"thread_id"`
	DisplayName        string `json:"display_name"`
	LastMessageSnippet string `json:"last_message_snippet"`
	LastMessageAt      string `json:"last_message_at"`
	ParticipantCount   int    `json:"participant_count"`
}

func (a *IMessageAdapter) listThreads(ctx context.Context, params map[string]any) (*adapters.Result, error) {
	maxResults := 20
	if v, ok := paramInt(params, "max_results"); ok && v > 0 && v <= 50 {
		maxResults = v
	}

	db, err := a.openDB()
	if err != nil {
		return nil, fmt.Errorf("imessage: cannot open chat.db: %w", err)
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT c.chat_identifier, c.display_name,
		       MAX(m.text) as last_text,
		       MAX(m.date) as last_date,
		       COUNT(DISTINCT ch.handle_id) as participant_count
		FROM chat c
		JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
		JOIN message m ON m.ROWID = cmj.message_id
		LEFT JOIN chat_handle_join ch ON ch.chat_id = c.ROWID
		WHERE m.date > 0
		GROUP BY c.ROWID
		ORDER BY last_date DESC
		LIMIT ?`, maxResults)
	if err != nil {
		return nil, fmt.Errorf("imessage list_threads query: %w", err)
	}
	defer rows.Close()

	coredataEpoch := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	items := make([]threadItem, 0)
	for rows.Next() {
		var threadID, displayName string
		var lastText sql.NullString
		var lastDateNS int64
		var participantCount int
		if err := rows.Scan(&threadID, &displayName, &lastText, &lastDateNS, &participantCount); err != nil {
			continue
		}
		lastAt := coredataEpoch.Add(time.Duration(lastDateNS))
		name := displayName
		if name == "" {
			name = threadID
		}
		snippet := ""
		if lastText.Valid {
			snippet = format.SanitizeText(lastText.String, format.MaxSnippetLen)
		}
		items = append(items, threadItem{
			ThreadID:           threadID,
			DisplayName:        format.SanitizeText(name, format.MaxFieldLen),
			LastMessageSnippet: snippet,
			LastMessageAt:      lastAt.UTC().Format(time.RFC3339),
			ParticipantCount:   participantCount,
		})
	}
	return &adapters.Result{
		Summary: format.Summary("%d recent conversation(s)", len(items)),
		Data:    items,
	}, nil
}

// ── get_thread ────────────────────────────────────────────────────────────────

func (a *IMessageAdapter) getThread(ctx context.Context, params map[string]any) (*adapters.Result, error) {
	contact, _ := params["contact"].(string)
	threadID, _ := params["thread_id"].(string)
	if contact == "" && threadID == "" {
		return nil, fmt.Errorf("imessage get_thread: contact or thread_id is required")
	}
	maxResults := 50
	if v, ok := paramInt(params, "max_results"); ok && v > 0 && v <= 200 {
		maxResults = v
	}
	daysBack := 30
	if v, ok := paramInt(params, "days_back"); ok && v > 0 {
		daysBack = v
	}

	db, err := a.openDB()
	if err != nil {
		return nil, fmt.Errorf("imessage: cannot open chat.db: %w", err)
	}
	defer db.Close()

	coredataEpoch := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	since := time.Now().Add(-time.Duration(daysBack) * 24 * time.Hour)
	sinceApple := since.Sub(coredataEpoch).Nanoseconds()

	var sqlQuery string
	var args []any

	if contact != "" {
		identifiers, _ := a.resolveContactIdentifiers(db, contact)
		if len(identifiers) == 0 {
			identifiers = []string{contact} // fallback: use value directly
		}
		placeholders := make([]string, len(identifiers))
		for i, id := range identifiers {
			placeholders[i] = "?"
			args = append(args, id)
		}
		args = append(args, sinceApple, maxResults)
		sqlQuery = fmt.Sprintf(`
			SELECT m.ROWID, m.text, m.is_from_me, m.date, COALESCE(h.id, ''), c.chat_identifier
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
			JOIN handle ch ON ch.ROWID = chj.handle_id AND ch.id IN (%s)
			WHERE m.date > ?
			ORDER BY m.date ASC
			LIMIT ?`, strings.Join(placeholders, ","))
	} else {
		args = []any{threadID, sinceApple, maxResults}
		sqlQuery = `
			SELECT m.ROWID, m.text, m.is_from_me, m.date, COALESCE(h.id, ''), c.chat_identifier
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE c.chat_identifier = ?
			  AND m.date > ?
			ORDER BY m.date ASC
			LIMIT ?`
	}

	rows, err := db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("imessage get_thread query: %w", err)
	}
	defer rows.Close()

	msgs := a.scanMessages(rows)
	nameMap := a.buildNameMap(db, msgs)
	messages := a.formatMessages(msgs, nameMap)

	displayName := contact
	if displayName == "" {
		displayName = threadID
	}
	result := map[string]any{
		"thread_id": threadID,
		"contact":   displayName,
		"messages":  messages,
	}
	return &adapters.Result{
		Summary: format.Summary("Last %d days of messages with %s (%d messages)", daysBack, displayName, len(messages)),
		Data:    result,
	}, nil
}

// ── send_message ──────────────────────────────────────────────────────────────

// SendMessage sends an iMessage via AppleScript.
// NOTE: This action ALWAYS requires human approval regardless of policy.
// The gateway handler enforces this before calling Execute.
func (a *IMessageAdapter) sendMessage(ctx context.Context, params map[string]any) (*adapters.Result, error) {
	to, _ := params["to"].(string)
	text, _ := params["text"].(string)
	if to == "" {
		return nil, fmt.Errorf("imessage send_message: to is required")
	}
	if text == "" {
		return nil, fmt.Errorf("imessage send_message: text is required")
	}
	if len(text) > 2000 {
		return nil, fmt.Errorf("imessage send_message: text exceeds 2000 characters")
	}
	if runtime.GOOS != "darwin" {
		return nil, fmt.Errorf("imessage send_message: not supported on this platform")
	}

	// Resolve phone number / email from contact name if needed.
	identifier := to
	db, dbErr := a.openDB()
	if dbErr == nil {
		defer db.Close()
		identifiers, _ := a.resolveContactIdentifiers(db, to)
		if len(identifiers) > 0 {
			identifier = identifiers[0]
		}
	}

	script := fmt.Sprintf(`tell application "Messages"
	set targetService to 1st service whose service type = iMessage
	set targetBuddy to buddy %q of targetService
	send %q to targetBuddy
end tell`, identifier, text)

	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("imessage send_message: AppleScript failed: %w — %s", err, truncate(string(out), 200))
	}
	return &adapters.Result{
		Summary: format.Summary("iMessage sent to %s", to),
		Data:    map[string]string{"to": to, "to_identifier": identifier},
	}, nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type rawMessage struct {
	rowID      int64
	text       sql.NullString
	isFromMe   bool
	dateNS     int64
	handleID   string
	chatID     string
}

func (a *IMessageAdapter) scanMessages(rows *sql.Rows) []rawMessage {
	var msgs []rawMessage
	for rows.Next() {
		var m rawMessage
		var isFromMeInt int
		if err := rows.Scan(&m.rowID, &m.text, &isFromMeInt, &m.dateNS, &m.handleID, &m.chatID); err != nil {
			continue
		}
		m.isFromMe = isFromMeInt != 0
		msgs = append(msgs, m)
	}
	return msgs
}

func (a *IMessageAdapter) formatMessages(msgs []rawMessage, nameMap map[string]string) []messageResult {
	coredataEpoch := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	results := make([]messageResult, 0, len(msgs))
	for _, m := range msgs {
		if !m.text.Valid || strings.TrimSpace(m.text.String) == "" {
			continue
		}
		ts := coredataEpoch.Add(time.Duration(m.dateNS))
		from := m.handleID
		displayName := nameMap[m.handleID]
		if displayName == "" {
			displayName = m.handleID
		}
		if m.isFromMe {
			displayName = "me"
			from = "me"
		}
		results = append(results, messageResult{
			ID:             fmt.Sprintf("msg-%d", m.rowID),
			From:           displayName,
			FromIdentifier: from,
			Text:           format.SanitizeText(m.text.String, format.MaxBodyLen),
			Timestamp:      ts.UTC().Format(time.RFC3339),
			IsFromMe:       m.isFromMe,
			ThreadID:       m.chatID,
		})
	}
	return results
}

// buildNameMap resolves handle IDs to display names using the AddressBook DB.
func (a *IMessageAdapter) buildNameMap(db *sql.DB, msgs []rawMessage) map[string]string {
	nameMap := make(map[string]string)
	// Collect unique non-me handle IDs.
	ids := make(map[string]bool)
	for _, m := range msgs {
		if !m.isFromMe && m.handleID != "" {
			ids[m.handleID] = true
		}
	}
	if len(ids) == 0 {
		return nameMap
	}

	// Try to find names in AddressBook. Best-effort; silently fail.
	abPaths, _ := filepath.Glob(filepath.Join(os.Getenv("HOME"),
		"Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb"))
	if len(abPaths) == 0 {
		return nameMap
	}

	abDB, err := sql.Open("sqlite", "file:"+abPaths[0]+"?mode=ro&immutable=1")
	if err != nil {
		return nameMap
	}
	defer abDB.Close()

	for id := range ids {
		var firstName, lastName sql.NullString
		err := abDB.QueryRow(`
			SELECT p.ZFIRSTNAME, p.ZLASTNAME
			FROM ZABCDRECORD p
			JOIN ZABCDPHONENUMBER pn ON pn.ZOWNER = p.Z_PK
			WHERE pn.ZFULLNUMBER LIKE ?
			LIMIT 1`, "%"+normalizePhone(id)+"%").
			Scan(&firstName, &lastName)
		if err != nil {
			// Try email
			err = abDB.QueryRow(`
				SELECT p.ZFIRSTNAME, p.ZLASTNAME
				FROM ZABCDRECORD p
				JOIN ZABCDEMAILADDRESS ea ON ea.ZOWNER = p.Z_PK
				WHERE lower(ea.ZADDRESS) = lower(?)
				LIMIT 1`, id).Scan(&firstName, &lastName)
		}
		if err == nil {
			parts := []string{}
			if firstName.Valid {
				parts = append(parts, firstName.String)
			}
			if lastName.Valid {
				parts = append(parts, lastName.String)
			}
			if len(parts) > 0 {
				nameMap[id] = strings.Join(parts, " ")
			}
		}
	}
	return nameMap
}

// resolveContactIdentifiers finds phone/email handles in chat.db matching a contact name.
func (a *IMessageAdapter) resolveContactIdentifiers(db *sql.DB, contact string) ([]string, error) {
	rows, err := db.Query(`SELECT DISTINCT id FROM handle WHERE id LIKE ?`,
		"%"+contact+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}

	// Also look in AddressBook for the contact name → phone/email.
	abPaths, _ := filepath.Glob(filepath.Join(os.Getenv("HOME"),
		"Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb"))
	if len(abPaths) > 0 {
		abDB, err := sql.Open("sqlite", "file:"+abPaths[0]+"?mode=ro&immutable=1")
		if err == nil {
			defer abDB.Close()
			// Look up by first+last name.
			abRows, err := abDB.Query(`
				SELECT pn.ZFULLNUMBER, ea.ZADDRESS
				FROM ZABCDRECORD p
				LEFT JOIN ZABCDPHONENUMBER pn ON pn.ZOWNER = p.Z_PK
				LEFT JOIN ZABCDEMAILADDRESS ea ON ea.ZOWNER = p.Z_PK
				WHERE (p.ZFIRSTNAME || ' ' || COALESCE(p.ZLASTNAME,'')) LIKE ?
				   OR p.ZFIRSTNAME LIKE ?
				   OR p.ZLASTNAME LIKE ?`,
				"%"+contact+"%", "%"+contact+"%", "%"+contact+"%")
			if err == nil {
				defer abRows.Close()
				for abRows.Next() {
					var phone, email sql.NullString
					if err := abRows.Scan(&phone, &email); err == nil {
						if phone.Valid && phone.String != "" {
							ids = append(ids, normalizePhone(phone.String))
						}
						if email.Valid && email.String != "" {
							ids = append(ids, strings.ToLower(email.String))
						}
					}
				}
			}
		}
	}
	return ids, nil
}

// normalizePhone strips non-digit characters to normalize phone numbers.
func normalizePhone(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' || r == '+' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func paramInt(params map[string]any, key string) (int, bool) {
	v, ok := params[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

// MarshalJSON is used to store empty credentials for local services.
func emptyCredential() []byte {
	b, _ := json.Marshal(map[string]string{"type": "local"})
	return b
}

func truncate(s string, max int) string {
	if len(s) > max {
		return s[:max] + "..."
	}
	return s
}
