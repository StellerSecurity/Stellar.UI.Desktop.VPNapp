import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProvider } from './app/AppProvider';
import { createContainer } from './app/container';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import '../stellar-tokens.css';
import '../vpn.css';
import './shared/design-system/desktop.css';
import { TrayApp } from './features/tray/ui/TrayApp';
import './features/tray/ui/tray.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const container = createContainer();
const surface = new URLSearchParams(location.search).get('surface') === 'tray' ? 'tray' : 'main';
document.documentElement.classList.toggle('tray-surface', surface === 'tray');
createRoot(root).render(<ErrorBoundary><AppProvider container={container} surface={surface}>{surface === 'tray' ? <TrayApp /> : <App />}</AppProvider></ErrorBoundary>);
