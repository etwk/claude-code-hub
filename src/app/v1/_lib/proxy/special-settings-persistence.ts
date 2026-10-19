import { logger } from "@/lib/logger";
import { SessionManager } from "@/lib/session-manager";
import { updateMessageRequestDetails } from "@/repository/message";
import type { ProxySession } from "./session";

const pendingWrites = new WeakMap<ProxySession, Promise<void>>();

/** Order incremental audit writes without replacing an already finalized request. */
export async function persistSpecialSettings(session: ProxySession): Promise<void> {
  const previousWrite = pendingWrites.get(session);
  let specialSettings = session.getSpecialSettings();
  if ((!specialSettings || specialSettings.length === 0) && !previousWrite) return;

  let releaseWrite!: () => void;
  const completed = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  pendingWrites.set(session, completed);

  try {
    if (previousWrite) {
      await previousWrite;
      specialSettings = session.getSpecialSettings();
    }

    if (session.sessionId && session.shouldPersistSessionDebugArtifacts()) {
      await SessionManager.storeSessionSpecialSettings(
        session.sessionId,
        specialSettings,
        session.requestSequence
      ).catch((error) => {
        logger.error("[SpecialSettings] Failed to store session audit", {
          error,
          sessionId: session.sessionId,
        });
      });
    }

    if (session.messageContext?.id) {
      await updateMessageRequestDetails(
        session.messageContext.id,
        { specialSettings },
        { onlyIfUnfinalized: true, awaitCommitObservers: false }
      ).catch((error) => {
        logger.error("[SpecialSettings] Failed to persist request audit", {
          error,
          messageRequestId: session.messageContext?.id,
        });
      });
    }
  } finally {
    releaseWrite();
    if (pendingWrites.get(session) === completed) pendingWrites.delete(session);
  }
}
