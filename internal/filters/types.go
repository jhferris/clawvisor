package filters

// ResponseFilter defines a single filter to apply to adapter results.
// Exactly one filter type is set per entry.
type ResponseFilter struct {
	Redact        string `yaml:"redact,omitempty" json:"redact,omitempty"`
	RedactRegex   string `yaml:"redact_regex,omitempty" json:"redact_regex,omitempty"`
	RemoveField   string `yaml:"remove_field,omitempty" json:"remove_field,omitempty"`
	TruncateField string `yaml:"truncate_field,omitempty" json:"truncate_field,omitempty"`
	MaxChars      int    `yaml:"max_chars,omitempty" json:"max_chars,omitempty"`
	Semantic      string `yaml:"semantic,omitempty" json:"semantic,omitempty"`
}

func (f ResponseFilter) IsStructural() bool { return f.Semantic == "" }
func (f ResponseFilter) IsSemantic() bool   { return f.Semantic != "" }
