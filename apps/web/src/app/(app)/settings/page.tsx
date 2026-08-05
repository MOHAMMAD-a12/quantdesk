'use client';

import { Settings, Bell, Key, Shield, User } from 'lucide-react';

export default function SettingsPage(): JSX.Element {
  return (
    <>
      <div className="mb-6">
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text">Account settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your profile, notifications, API keys and risk preferences.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { icon: User, title: 'Profile', description: 'Display name, email, timezone', href: '/settings/profile' },
          { icon: Shield, title: 'Security', description: 'Password and session management', href: '/settings/security' },
          { icon: Bell, title: 'Notifications', description: 'Telegram, email, Discord, web push', href: '/settings/notifications' },
          { icon: Key, title: 'API keys', description: 'Create and manage API keys', href: '/settings/api-keys' },
          { icon: Settings, title: 'Risk preferences', description: 'Risk per trade, daily/weekly limits', href: '/settings/risk' },
          { icon: Bell, title: 'Watchlist', description: 'Symbols to scan and notify on', href: '/settings/watchlist' },
        ].map(({ icon: Icon, title, description, href }) => (
          <a key={href} href={href} className="panel flex items-start gap-4 p-5 transition-colors hover:bg-panel-raised/45">
            <span className="grid size-10 place-items-center rounded-xl bg-panel-raised"><Icon className="size-5 text-brand" /></span>
            <div>
              <p className="text-sm font-semibold text-text">{title}</p>
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
