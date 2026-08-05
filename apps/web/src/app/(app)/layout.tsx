import { AppShell } from '@/components/layout/app-shell';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <AppShell>{children}</AppShell>;
}
