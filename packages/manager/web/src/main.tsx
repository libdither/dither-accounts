/** Entry: render, load the state and keep it current while the page is visible. */
import { render } from 'preact';
import { loadState, startPolling } from './state.ts';
import './styles.css';
import { App } from './ui/App.tsx';

render(<App />, document.getElementById('app')!);
void loadState();
startPolling();
