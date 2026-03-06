package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/clawvisor/clawvisor/internal/mcp"
)

// MCPHandler handles POST /mcp — the MCP JSON-RPC 2.0 endpoint.
type MCPHandler struct {
	server  *mcp.Server
	baseURL string
}

// NewMCPHandler creates an MCP handler.
func NewMCPHandler(server *mcp.Server, baseURL string) *MCPHandler {
	return &MCPHandler{server: server, baseURL: baseURL}
}

// Handle processes an MCP JSON-RPC request.
// Agent authentication is handled by the requireAgent middleware.
func (h *MCPHandler) Handle(w http.ResponseWriter, r *http.Request) {
	var req mcp.Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(mcp.Response{
			JSONRPC: "2.0",
			Error:   &mcp.ErrorObject{Code: mcp.CodeParseError, Message: "invalid JSON"},
		})
		return
	}

	if req.JSONRPC != "2.0" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(mcp.Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &mcp.ErrorObject{Code: mcp.CodeInvalidRequest, Message: "jsonrpc must be 2.0"},
		})
		return
	}

	resp := h.server.HandleJSONRPC(w, r, &req)

	// Notifications don't get a response.
	if resp == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
