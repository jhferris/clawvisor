package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/clawvisor/clawvisor/internal/api/middleware"
	"github.com/clawvisor/clawvisor/internal/events"
)

// EventsHandler serves the SSE event stream.
type EventsHandler struct {
	hub *events.Hub
}

// NewEventsHandler creates a new SSE handler.
func NewEventsHandler(hub *events.Hub) *EventsHandler {
	return &EventsHandler{hub: hub}
}

// Stream handles GET /api/events — an SSE endpoint that pushes invalidation events.
func (h *EventsHandler) Stream(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
		return
	}

	rc := http.NewResponseController(w)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, unsub := h.hub.Subscribe(user.ID)
	defer unsub()

	keepalive := time.NewTicker(30 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			// Extend the write deadline before each write so the connection
			// stays alive, but can still be closed during graceful shutdown.
			_ = rc.SetWriteDeadline(time.Now().Add(60 * time.Second))
			if _, err := fmt.Fprintf(w, ":keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case evt, ok := <-ch:
			if !ok {
				return
			}
			_ = rc.SetWriteDeadline(time.Now().Add(60 * time.Second))
			data, _ := json.Marshal(evt)
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
