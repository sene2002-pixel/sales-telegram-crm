import { useState } from 'react';
import { Actor } from '../shared/contracts';
import { HomeActions } from './HomeActions';
import { HomeIdea } from './HomeIdea';
import { HomeSupport } from './HomeSupport';

export function HomeExtras({ user, users }: { user: Actor; users: Actor[] }) {
  const [screen, setScreen] = useState<'support' | 'idea' | null>(null);
  return (
    <>
      <HomeActions
        user={user}
        users={users}
        onSupport={() => setScreen('support')}
        onIdea={() => setScreen('idea')}
      />
      {screen === 'support' && <HomeSupport actorId={user.id} onClose={() => setScreen(null)} />}
      {screen === 'idea' && <HomeIdea onClose={() => setScreen(null)} />}
    </>
  );
}
