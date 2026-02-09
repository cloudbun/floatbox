/**
 * Entry point for the UAR tool.
 *
 * Imports design tokens and reset styles before rendering the root App
 * component. Tailwind directives are imported via index.css if present,
 * or the app functions with the custom CSS alone.
 */

import './styles/tokens.css';
import './styles/reset.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
);
