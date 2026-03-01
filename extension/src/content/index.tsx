import React from 'react';
import ReactDOM from 'react-dom/client';
import { Sidebar } from './Sidebar';
import { ThemeProvider } from './components/ThemeContext';
import styleText from './style.css?inline';

const host = document.createElement('div');
host.id = 'alpha-bridge-v2-host';

// Stop all keyboard events from bubbling up to TradingView's document listeners
host.addEventListener('keydown', (e) => { e.stopPropagation(); });
host.addEventListener('keyup', (e) => { e.stopPropagation(); });
host.addEventListener('keypress', (e) => { e.stopPropagation(); });

document.body.appendChild(host);

const shadowRoot = host.attachShadow({ mode: 'open' });

const styleElement = document.createElement('style');
styleElement.textContent = styleText;
shadowRoot.appendChild(styleElement);

const appRoot = document.createElement('div');
appRoot.id = 'alpha-bridge-app-root';
shadowRoot.appendChild(appRoot);

const root = ReactDOM.createRoot(appRoot);
root.render(
    <React.StrictMode>
        <ThemeProvider>
            <Sidebar />
        </ThemeProvider>
    </React.StrictMode>
);

console.log("Alpha Bridge v2 Content Script & Shadow DOM attached successfully.");
