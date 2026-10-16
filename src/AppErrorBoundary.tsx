import React from 'react';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';

interface BoundaryState { error: Error | null }

export default class AppErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Nexus renderer recovered from a UI error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-screen" role="alert">
      <div className="fatal-brand"><span><Sparkles size={17} /></span><strong>nexus<span>studio</span></strong></div>
      <div className="fatal-card"><div className="fatal-icon"><AlertTriangle size={20} /></div><p className="eyebrow">WORKBENCH RECOVERY</p><h1>The interface hit a snag.</h1><p className="fatal-copy">Your saved conversations are kept on this device. Reload the window to recover the workbench.</p><pre>{this.state.error.message || 'Unexpected interface error'}</pre><button className="primary-button" onClick={() => window.location.reload()}><RefreshCw size={15} /> Reload Nexus</button></div>
    </main>;
  }
}
