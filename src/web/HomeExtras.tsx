import { useState } from 'react';
import { Actor } from '../shared/contracts';
import { HomeActions } from './HomeActions';
import { HomeSupport } from './HomeSupport';

export function HomeExtras({
  user,
  users,
  onIdea,
}: {
  user: Actor;
  users: Actor[];
  onIdea: () => void;
}) {
  const [screen, setScreen] = useState<'support' | null>(null);
  return (
    <>
      <HomeActions
        user={user}
        users={users}
        onSupport={() => setScreen('support')}
        onIdea={onIdea}
      />
      {screen === 'support' && <HomeSupport actorId={user.id} onClose={() => setScreen(null)} />}
    </>
  );
}
