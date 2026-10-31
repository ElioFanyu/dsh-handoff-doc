/**
 * Redaction for text that leaves the session and enters another one.
 *
 * A handoff brief is model-authored prose about the work so far. In a real
 * session that prose routinely quotes configuration files, command lines, and
 * `.env` contents — the previous model read them to do the job. Carrying that
 * verbatim into a new session is a second chance for a secret to be copied
 * somewhere it was never checked.
 *
 * The rules here are conservative on purpose: they remove things that look like
 * credentials regardless of context, and leave ordinary prose, file paths, and
 * code untouched. Over-redacting a sentence is recoverable; leaking a token is
 * not. Every rule is anchored so short words like "key" or "token" inside a
 * normal sentence do not match.
 */

/** One redaction rule, applied in order. */
interface Rule {
  readonly name: string
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * Rules run in this order. Specific patterns come before generic ones so a rule
 * never partially consumes text another rule uses as a marker: an env
 * assignment such as `OPENAI_API_KEY=sk-...` must be removed as a whole before
 * the provider-token rule could leave a stray suffix behind.
 */
const RULES: readonly Rule[] = [
  {
    name: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    replacement: '[redacted: private key]',
  },
  {
    name: 'env-assignment',
    // NAME=value where NAME looks like a secret carrier and the value is long
    // enough to be one. Quoted values are handled by allowing quotes. The value
    // must not already be a redaction marker, so a second pass over redacted
    // text does not consume the bracket that follows it.
    //
    // The value must also *look like a credential*: at least 8 characters of
    // ASCII with no whitespace and no CJK punctuation. Two real documents were
    // corrupted before this rule had that guard — prose such as
    // `TOKENS_PER_CHAR = 1`（中文一字一 token；...） matched because the name
    // contains TOKEN and the "value" was everything up to the first ASCII
    // space, so the replacement swallowed the rest of the clause and left
    // `TOKENS_PER_CHAR=[redacted] token）`. A bare digit or a short word is not
    // a secret, and treating it as one destroys the sentence that explains it.
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("[^"]{8,}"|'[^']{8,}'|(?!\[redacted\b)[A-Za-z0-9_\-+/=.]{8,}(?![A-Za-z0-9_\-+/=.]))/g,
    replacement: '$1=[redacted]',
  },
  {
    name: 'known-token-prefix',
    // sk-..., ghp_..., gho_..., github_pat_..., xox[bpa]-..., AKIA..., glpat-...
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replacement: '[redacted: token]',
  },
  {
    name: 'authorization-header',
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    replacement: '$1 [redacted]',
  },
  {
    name: 'connection-string-password',
    // scheme://user:password@host
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi,
    replacement: '$1:[redacted]@',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[redacted: jwt]',
  },
  {
    name: 'long-hex-secret',
    // 32+ hex chars: hashes, keys, ids. Ordinary prose practically never has
    // them, and a brief does not need them verbatim. Brackets are excluded so
    // a placeholder such as `[redacted: hex]` is never partly re-matched.
    pattern: /\b[0-9a-fA-F]{32,}\b/g,
    replacement: '[redacted: hex]',
  },
  {
    name: 'long-base64-secret',
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    replacement: '[redacted: base64]',
  },
]

/** Apply every rule and report which ones fired. */
export function redactWithReport(text: string): {
  readonly text: string
  readonly applied: readonly string[]
} {
  let current = text
  const applied: string[] = []
  for (const rule of RULES) {
    // `lastIndex` is stateful on /g regexes shared across calls.
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(current)) {
      rule.pattern.lastIndex = 0
      current = current.replace(rule.pattern, rule.replacement)
      applied.push(rule.name)
    }
  }
  return { text: current, applied }
}

/** Redact one string. */
export function redact(text: string): string {
  return redactWithReport(text).text
}
