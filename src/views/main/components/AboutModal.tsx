import { X } from "lucide-react";
import { APP_INFO } from "../../../shared/app-info";

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal about-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">About</p>
            <h2>{APP_INFO.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close about">
            <X size={18} />
          </button>
        </header>
        <section className="about-body">
          <img className="about-icon" src={APP_INFO.iconPath} alt="" />
          <div className="about-copy">
            <strong>
              {APP_INFO.name} v.{APP_INFO.version}
            </strong>
            <span>{APP_INFO.tagline}</span>
            <small>{APP_INFO.developer}</small>
          </div>
        </section>
      </div>
    </div>
  );
}
