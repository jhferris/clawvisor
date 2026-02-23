import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { EditorView, basicSetup } from 'codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { api, type ValidationResult, type PolicyDecision, type SemanticConflict } from '../api/client'

const PLACEHOLDER_YAML = `id: my-policy
name: My Policy
# role: agent-role-name   # optional: target a specific role
rules:
  - service: google.gmail
    actions: [send_message]
    allow: false
    reason: Sending email requires human approval
`

export default function PolicyEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [yamlContent, setYamlContent] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiGenerated, setAiGenerated] = useState(false)

  // Dry-run state
  const [evalService, setEvalService] = useState('')
  const [evalAction, setEvalAction] = useState('')
  const [evalRole, setEvalRole] = useState('')
  const [evalResult, setEvalResult] = useState<PolicyDecision | null>(null)
  const [isEvaluating, setIsEvaluating] = useState(false)

  // Generate panel state
  const [generateOpen, setGenerateOpen] = useState(() =>
    localStorage.getItem('policy-generate-open') === 'true'
  )
  const [genDescription, setGenDescription] = useState('')
  const [genRole, setGenRole] = useState('')
  const [genError, setGenError] = useState<string | null>(null)

  const isEdit = Boolean(id)

  // Fetch existing policy when editing
  const { data: existingPolicy, isLoading: isLoadingPolicy } = useQuery({
    queryKey: ['policy', id],
    queryFn: () => api.policies.get(id!),
    enabled: isEdit,
  })

  // Fetch roles for Generate panel dropdown
  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.roles.list(),
  })

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current || viewRef.current) return
    const initialContent = isEdit ? '' : PLACEHOLDER_YAML
    const view = new EditorView({
      doc: initialContent,
      extensions: [
        basicSetup,
        yaml(),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            const content = update.state.doc.toString()
            setYamlContent(content)
            setAiGenerated(false) // clear AI banner on manual edit
          }
        }),
      ],
      parent: editorRef.current,
    })
    viewRef.current = view
    if (!isEdit) setYamlContent(initialContent)

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [isEdit])

  // Populate editor when existing policy loads
  useEffect(() => {
    if (existingPolicy && viewRef.current) {
      const view = viewRef.current
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: existingPolicy.rules_yaml },
      })
      setYamlContent(existingPolicy.rules_yaml)
    }
  }, [existingPolicy])

  // Debounced validation (no semantic check on keystroke)
  const validate = useCallback(async (content: string) => {
    if (!content.trim()) {
      setValidation(null)
      return
    }
    setIsValidating(true)
    try {
      const result = await api.policies.validate(content)
      setValidation(result)
    } catch {
      // ignore
    } finally {
      setIsValidating(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => validate(yamlContent), 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [yamlContent, validate])

  // Save with semantic conflict check on explicit save
  const saveMut = useMutation({
    mutationFn: async () => {
      // Run semantic check on save (check_semantic=true)
      const v = await api.policies.validate(yamlContent, true)
      setValidation(v)
      if (!v.valid) throw new Error('Policy is invalid')
      return isEdit
        ? api.policies.update(id!, yamlContent)
        : api.policies.create(yamlContent)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policies'] })
      navigate('/dashboard/policies')
    },
    onError: (err: Error) => setError(err.message),
  })

  // Generate policy from description
  const generateMut = useMutation({
    mutationFn: () => {
      const existingIDs = roles?.map(r => r.name) // reuse role names as hints
      return api.policies.generate(genDescription, {
        role: genRole || undefined,
        existing_ids: existingIDs,
      })
    },
    onSuccess: (data) => {
      if (viewRef.current && yamlContent.trim()) {
        if (!confirm('Replace current policy content with the generated version?')) return
      }
      if (viewRef.current) {
        const view = viewRef.current
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: data.yaml },
        })
        setYamlContent(data.yaml)
      }
      setAiGenerated(true)
      setGenError(null)
    },
    onError: (err: Error) => setGenError(err.message),
  })

  function toggleGenerate(open: boolean) {
    setGenerateOpen(open)
    localStorage.setItem('policy-generate-open', String(open))
  }

  async function handleEvaluate() {
    if (!evalService || !evalAction) return
    setIsEvaluating(true)
    setEvalResult(null)
    try {
      const result = await api.policies.evaluate({
        service: evalService,
        action: evalAction,
        role: evalRole || undefined,
      })
      setEvalResult(result)
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message)
    } finally {
      setIsEvaluating(false)
    }
  }

  if (isEdit && isLoadingPolicy) {
    return <div className="p-8 text-sm text-gray-400">Loading policy…</div>
  }

  const decisionColor: Record<string, string> = {
    execute: 'text-green-700 bg-green-50',
    approve: 'text-yellow-700 bg-yellow-50',
    block: 'text-red-700 bg-red-50',
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">
          {isEdit ? 'Edit Policy' : 'New Policy'}
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/dashboard/policies')}
            className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || (validation !== null && !validation.valid)}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saveMut.isPending ? 'Saving…' : 'Save Policy'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 text-sm rounded">{error}</div>
      )}

      {/* Generate from description panel */}
      <div className="border rounded-lg overflow-hidden">
        <button
          onClick={() => toggleGenerate(!generateOpen)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          <span>Generate from description</span>
          <span className="text-gray-400">{generateOpen ? '▾' : '▸'}</span>
        </button>
        {generateOpen && (
          <div className="p-4 space-y-3 bg-white">
            <textarea
              value={genDescription}
              onChange={e => setGenDescription(e.target.value)}
              placeholder="Describe what you want this policy to do…"
              rows={3}
              className="block w-full text-sm rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
            />
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-xs text-gray-500">Role (optional)</label>
                <select
                  value={genRole}
                  onChange={e => setGenRole(e.target.value)}
                  className="mt-0.5 block w-full text-sm rounded border border-gray-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="">All agents (global)</option>
                  {roles?.map(r => (
                    <option key={r.id} value={r.name}>{r.name}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => generateMut.mutate()}
                disabled={generateMut.isPending || !genDescription.trim()}
                className="mt-4 px-4 py-1.5 text-sm rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap"
              >
                {generateMut.isPending ? 'Generating…' : 'Generate'}
              </button>
            </div>
            {genError && <div className="text-xs text-red-600">{genError}</div>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Left: YAML editor */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700">Policy YAML</label>
            {isValidating && <span className="text-xs text-gray-400">Validating…</span>}
            {validation && !isValidating && (
              <span className={`text-xs font-medium ${validation.valid ? 'text-green-600' : 'text-red-600'}`}>
                {validation.valid ? '✓ Valid' : '✗ Invalid'}
              </span>
            )}
          </div>

          {aiGenerated && (
            <div className="flex items-center gap-2 text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded px-3 py-1.5">
              <span>ℹ</span>
              <span>AI-generated — review before saving</span>
            </div>
          )}

          <div
            ref={editorRef}
            className="border rounded-lg overflow-hidden text-sm [&_.cm-editor]:min-h-72 [&_.cm-scroller]:font-mono"
          />

          {validation && !validation.valid && validation.errors.length > 0 && (
            <ul className="space-y-1">
              {validation.errors.map((e, i) => (
                <li key={i} className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded">{e}</li>
              ))}
            </ul>
          )}

          {validation?.conflicts && validation.conflicts.length > 0 && (
            <div className="space-y-1">
              {validation.conflicts.map((c, i) => (
                <div key={i} className="text-xs text-yellow-700 bg-yellow-50 px-3 py-1.5 rounded">
                  ⚠ {c.message}
                </div>
              ))}
            </div>
          )}

          {/* Semantic conflict warnings (only on save, when LLM is configured) */}
          {validation?.semantic_conflicts && validation.semantic_conflicts.length > 0 && (
            <div className="space-y-1">
              {validation.semantic_conflicts.map((sc: SemanticConflict, i: number) => (
                <div key={i} className={`text-xs px-3 py-1.5 rounded ${sc.severity === 'warning' ? 'text-purple-700 bg-purple-50' : 'text-blue-700 bg-blue-50'}`}>
                  🤖 {sc.description}
                  {sc.affected_policies.length > 0 && (
                    <span className="text-purple-400 ml-1">
                      ({sc.affected_policies.join(', ')})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Dry-run evaluator */}
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-gray-700">Dry-run Evaluator</h2>
          <p className="text-xs text-gray-400">
            Test what decision the saved policies would produce for a given request.
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500">Service</label>
              <input
                value={evalService}
                onChange={e => setEvalService(e.target.value)}
                placeholder="e.g. google.gmail"
                className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Action</label>
              <input
                value={evalAction}
                onChange={e => setEvalAction(e.target.value)}
                placeholder="e.g. send_message"
                className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Role (optional)</label>
              <input
                value={evalRole}
                onChange={e => setEvalRole(e.target.value)}
                placeholder="e.g. automation"
                className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <button
              onClick={handleEvaluate}
              disabled={isEvaluating || !evalService || !evalAction}
              className="w-full py-1.5 text-sm rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-40"
            >
              {isEvaluating ? 'Evaluating…' : 'Evaluate'}
            </button>
          </div>

          {evalResult && (
            <div className={`rounded-lg p-4 space-y-2 ${decisionColor[evalResult.decision] ?? 'bg-gray-50 text-gray-800'}`}>
              <div className="font-bold text-lg capitalize">{evalResult.decision}</div>
              {evalResult.reason && (
                <div className="text-xs">{evalResult.reason}</div>
              )}
              {evalResult.policy_id && (
                <div className="text-xs opacity-70">Policy: {evalResult.policy_id}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
