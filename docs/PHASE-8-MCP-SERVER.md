# Phase 8: MCP Server

## Goal
Expose Clawvisor as an MCP (Model Context Protocol) server. Each activated service/action becomes a native MCP tool. Policy enforcement and credential vaulting happen transparently — any MCP-compatible client gets the security layer for free.

---

## Deliverables
- MCP server endpoint (`/mcp` — SSE transport)
- Dynamic tool registration: tools generated from activated services + adapter metadata
- Policy enforcement on every MCP tool call (same path as gateway requests)
- MCP authentication (agent token via `Authorization` header or URL param)
- Compatible with Claude Desktop and other MCP clients
- Dashboard: MCP connection string + config snippet

---

## Background: MCP Protocol

MCP (Model Context Protocol) is a JSON-RPC 2.0 protocol over SSE (Server-Sent Events) or stdio. Clients connect to an MCP server and receive a list of available tools. They call tools by name with typed arguments; the server executes and returns results.

Clawvisor as an MCP server means:
- Claude Desktop connects to `http://localhost:8080/mcp`
- Claude sees tools: `gmail_list_messages`, `gmail_get_message`, `calendar_list_events`, `github_list_issues`, etc.
- When Claude calls a tool, Clawvisor evaluates policy, injects credentials, executes, and returns the result
- If approval is required, the MCP call blocks until approval is granted or times out

This makes Clawvisor usable beyond OpenClaw — any MCP client gets the security layer automatically.

---

## MCP Transport

Use **HTTP + SSE** transport (preferred for networked servers):
- `GET /mcp` — SSE stream for server→client messages
- `POST /mcp` — client→server JSON-RPC messages

Authentication: `Authorization: Bearer <agent_token>` on both connections.

---

## Dynamic Tool Generation

Tools are generated at connection time based on the user's activated services:

```go
// internal/mcp/tools.go

func GenerateTools(userID string, adapters []adapters.Adapter, vault Vault) []mcp.Tool {
    var tools []mcp.Tool
    for _, adapter := range adapters {
        if !vault.Has(userID, adapter.ServiceID()) {
            continue  // only expose activated services
        }
        for _, action := range adapter.SupportedActions() {
            tools = append(tools, mcp.Tool{
                Name:        mcpToolName(adapter.ServiceID(), action),
                Description: adapter.ActionDescription(action),
                InputSchema: adapter.ActionSchema(action),
            })
        }
    }
    return tools
}

// Tool naming: dots and underscores only, max 64 chars
// "google.gmail" + "list_messages" → "google_gmail__list_messages"
func mcpToolName(serviceID, action string) string {
    return strings.ReplaceAll(serviceID, ".", "_") + "__" + action
}
```

Tool definitions update when the user activates/deactivates a service — the SSE connection sends a `tools/list_changed` notification.

---

## Adapter Interface Extension

Add to the Adapter interface (Phase 3) for MCP support:

```go
// Each action needs a description and JSON Schema for MCP tool registration
ActionDescription(action string) string
ActionSchema(action string) map[string]any   // JSON Schema object
```

Example for `gmail__list_messages`:
```go
func (a *GmailAdapter) ActionDescription(action string) string {
    switch action {
    case "list_messages":
        return "List Gmail messages matching a search query. Returns message summaries without exposing credentials."
    // ...
    }
}

func (a *GmailAdapter) ActionSchema(action string) map[string]any {
    switch action {
    case "list_messages":
        return map[string]any{
            "type": "object",
            "properties": map[string]any{
                "query":       map[string]any{"type": "string", "description": "Gmail search query (e.g. 'is:unread')"},
                "max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": []string{"query"},
        }
    }
}
```

---

## MCP Request Handler

When a tool call arrives via MCP:

```go
func (s *MCPServer) HandleToolCall(ctx context.Context, userID string, toolName string, args map[string]any) (*mcp.CallToolResult, error) {

    serviceID, action := parseMCPToolName(toolName)

    // Route through the same gateway handler as HTTP requests
    gatewayReq := &gateway.Request{
        Service:   serviceID,
        Action:    action,
        Params:    args,
        Reason:    "MCP tool call",
        Context:   &gateway.RequestContext{Source: "mcp"},
        RequestID: uuid.New().String(),
    }

    result, err := s.gateway.Handle(ctx, userID, gatewayReq)
    if err != nil {
        return nil, err
    }

    switch result.Status {
    case "executed":
        return &mcp.CallToolResult{
            Content: []mcp.Content{{Type: "text", Text: formatResult(result)}},
        }, nil

    case "blocked":
        return &mcp.CallToolResult{
            IsError: true,
            Content: []mcp.Content{{Type: "text", Text: fmt.Sprintf("Blocked by policy: %s", result.Reason)}},
        }, nil

    case "pending":
        // MCP calls block until resolved (or timeout)
        resolved := <-s.waitForResolution(ctx, result.RequestID, s.config.ApprovalTimeout)
        if resolved.Status == "executed" {
            return &mcp.CallToolResult{
                Content: []mcp.Content{{Type: "text", Text: formatResult(resolved)}},
            }, nil
        }
        return &mcp.CallToolResult{
            IsError: true,
            Content: []mcp.Content{{Type: "text", Text: fmt.Sprintf("Request %s: %s", resolved.Status, resolved.Reason)}},
        }, nil
    }
}
```

Note: MCP tool calls block while waiting for approval, unlike the HTTP gateway which returns `pending` immediately. This is appropriate because MCP clients expect synchronous tool results.

MCP uses a **separate approval timeout** (`mcp.approval_timeout`, default: 240s) shorter than the gateway's `approval.timeout` (300s). This leaves a 60-second buffer before Cloud Run's request timeout (360s), avoiding a hard cutoff at the edge of the HTTP connection. Add to `config.yaml`:

```yaml
mcp:
  approval_timeout: 240    # seconds; MCP tool calls block this long waiting for approval
```

---

## Claude Desktop Configuration

The dashboard generates the MCP config snippet for Claude Desktop:

```json
{
  "mcpServers": {
    "clawvisor": {
      "url": "http://localhost:8080/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <your_agent_token>"
      }
    }
  }
}
```

Dashboard shows this snippet with the token pre-filled after agent token creation.

For Cloud Run:
```json
{
  "mcpServers": {
    "clawvisor": {
      "url": "https://your-instance.run.app/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <your_agent_token>"
      }
    }
  }
}
```

---

## Package Structure

```
internal/
└── mcp/
    ├── server.go         # SSE transport, JSON-RPC handler, session management
    ├── tools.go          # Dynamic tool generation from adapters
    ├── handler.go        # Tool call dispatch → gateway handler
    └── format.go         # Result formatting for MCP content blocks
```

---

## Go MCP Implementation

Use the official `github.com/modelcontextprotocol/go-sdk` if available and stable by Phase 8 build time. Otherwise implement the protocol directly — MCP over HTTP+SSE is ~300 lines of JSON-RPC handling. Keep the dependency optional.

---

## Success Criteria
- [ ] `GET /mcp` establishes SSE connection with valid agent token
- [ ] MCP `tools/list` returns tools for all activated services
- [ ] MCP `tools/call gmail__list_messages` executes and returns semantic result
- [ ] Blocked tool call returns MCP error with policy reason
- [ ] Approval-required tool call blocks, resolves after Telegram/dashboard approval
- [ ] Tools list updates when user activates a new service (SSE notification)
- [ ] Claude Desktop can connect and use tools end-to-end
- [ ] Unauthenticated MCP connection returns 401
- [ ] Dashboard shows MCP config snippet
