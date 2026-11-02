import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="boot-screen"><h1>Stellar VPN could not open this view.</h1><button onClick={() => location.reload()}>Try again</button></main>;
    return this.props.children;
  }
}
