'use client';

import { useActionState } from 'react';
import { Alert, Card, Field, SubmitButton, inputClass } from '@/components/ui';
import { joinWithCode } from './actions';

export function JoinForm() {
  const [state, action, pending] = useActionState(joinWithCode, undefined);
  return (
    <Card>
      <form action={action} className="space-y-4" aria-label="Join with an invite code">
        <div>
          <h2 className="text-lg font-semibold">Joining a restaurant’s team?</h2>
          <p className="text-sm text-stone-600">Type the code your owner or manager gave you.</p>
        </div>
        {state?.error ? <Alert>{state.error}</Alert> : null}
        <Field label="Invite code" htmlFor="code">
          <input id="code" name="code" required autoComplete="off" placeholder="AB12-CD34"
                 className={`${inputClass} font-mono uppercase tracking-widest`} />
        </Field>
        <div className="sm:w-48"><SubmitButton pending={pending}>Join team</SubmitButton></div>
      </form>
    </Card>
  );
}
