import type { CompatibilitySnapshot, SessionCode, SessionState } from "@mixerlink/shared";

export type ClientMessage =
  | {
      type: "session.create";
      payload: {
        displayName: string;
      };
    }
  | {
      type: "session.join";
      payload: {
        code: SessionCode;
        displayName: string;
      };
    }
  | {
      type: "session.leave";
    }
  | {
      type: "compatibility.update";
      payload: CompatibilitySnapshot;
    };

export type ServerMessage =
  | {
      type: "server.hello";
      payload: {
        app: "MixerLink";
        message: string;
      };
    }
  | {
      type: "session.created";
      payload: {
        code: SessionCode;
      };
    }
  | {
      type: "session.joined";
      payload: {
        code: SessionCode;
        collaboratorId: string;
      };
    }
  | {
      type: "session.state";
      payload: SessionState;
    }
  | {
      type: "session.left";
      payload: {
        code: SessionCode;
      };
    }
  | {
      type: "session.error";
      payload: {
        message: string;
      };
    };
