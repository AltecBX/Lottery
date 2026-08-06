import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last line of defence around the whole app.
 *
 * Everything this app renders is driven by data in localStorage, so a render
 * throw is not a one-off: reloading replays the same data and throws again,
 * leaving a white page with no way back. The recovery button is therefore the
 * point of this component rather than a nicety — it clears the stored state so
 * the next load starts clean.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Jerry Pattern Lab crashed:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '48px 20px', lineHeight: 1.55 }}>
        <h1 style={{ fontSize: 21, marginBottom: 10 }}>Something went wrong</h1>
        <p style={{ marginBottom: 14 }}>
          The app hit an error it could not recover from on its own. Your saved history is still
          on this device — reloading is the first thing to try.
        </p>
        <pre style={{
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12,
          padding: 12, borderRadius: 10, background: 'rgba(127,127,127,0.12)', marginBottom: 16,
        }}>{error.message}</pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
          <button
            className="btn"
            onClick={() => {
              if (!window.confirm('This deletes every game, draw and saved ticket stored on this device. Continue?')) return
              try {
                for (const k of Object.keys(window.localStorage)) {
                  if (k.startsWith('patternlab.')) window.localStorage.removeItem(k)
                }
              } catch { /* nothing more we can do */ }
              window.location.reload()
            }}
          >
            Clear stored data and reload
          </button>
        </div>
      </div>
    )
  }
}
