/** The frame: the top bar with the sections and logging out, the section, toasts and the confirm dialog. */
import { go, href, loadError, pending, section, type Section, state } from '../state.ts';
import { Accounts } from './Accounts.tsx';
import { useEffect } from 'preact/hooks';
import { AddSheet, openAddFromQuery } from './Add.tsx';
import { Activity } from './Activity.tsx';
import { Approvers } from './Approvers.tsx';
import { Apps } from './Apps.tsx';
import { ConfirmDialog, Toasts } from './bits.tsx';
import { Interfaces } from './Interfaces.tsx';
import { Sessions } from './Sessions.tsx';

const TABS: { id: Section; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'apps', label: 'Apps' },
  { id: 'activity', label: 'Activity' },
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'approvers', label: 'Approvers' },
  { id: 'sessions', label: 'Sessions' },
];

export function App() {
  const s = state.value;
  const n = pending.value;
  useEffect(() => void (s && openAddFromQuery(s)), [!!s]);
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/" aria-label="Accounts">
          <img src="/icon.svg" alt="" width="22" height="22" />
          <span>Accounts</span>
        </a>
        <nav class="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={href(t.id)}
              class={`tab ${section.value === t.id ? 'on' : ''}`}
              aria-current={section.value === t.id ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(t.id);
              }}
              data-tab={t.id}
            >
              {t.label}
              {t.id === 'apps' && n > 0 && (
                <span class="badge" data-pending title={`${n} waiting for you`}>
                  {n}
                </span>
              )}
            </a>
          ))}
        </nav>
        <form class="logout" method="post" action="/logout">
          <button type="submit" class="tab" data-logout>
            Log out
          </button>
        </form>
      </header>
      <main class="main">
        {loadError.value && (
          <p class="banner error" role="alert">
            The manager is not answering: {loadError.value}
          </p>
        )}
        {!s ? (
          <p class="muted page">Loading…</p>
        ) : section.value === 'apps' ? (
          <Apps />
        ) : section.value === 'activity' ? (
          <Activity />
        ) : section.value === 'interfaces' ? (
          <Interfaces />
        ) : section.value === 'sessions' ? (
          <Sessions />
        ) : section.value === 'approvers' ? (
          <Approvers />
        ) : (
          <Accounts />
        )}
      </main>
      {s && <AddSheet />}
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}
