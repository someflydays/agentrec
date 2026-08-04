import { type ReactElement, type ReactNode, useEffect } from "react";
import { registerOverlay } from "../lib/keyboard";

interface ModalProps {
  title: string;
  /** `palette` sits high on the page and grows wide; `panel` is centred. */
  variant?: "panel" | "palette";
  onClose: () => void;
  children: ReactNode;
}

export function Modal(props: ModalProps): ReactElement {
  const { onClose } = props;

  useEffect(() => registerOverlay(), []);

  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className={`overlay overlay--${props.variant ?? "panel"}`}>
      <button type="button" className="overlay-scrim" aria-label="Close" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="modal-head">
          <h2 className="modal-title">{props.title}</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            esc
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}
