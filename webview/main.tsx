import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { ExtensionBridgeProvider, createVsCodeApi } from './extensionBridge';
import './components/styles.css';

function init() {
  const container = document.getElementById('root');
  if (container) {
    const api = createVsCodeApi();
    const root = createRoot(container);
    root.render(
      <ExtensionBridgeProvider api={api}>
        <App />
      </ExtensionBridgeProvider>
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
