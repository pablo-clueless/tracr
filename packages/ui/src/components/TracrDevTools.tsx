import { useState, type ReactNode } from "react";

export type DevToolsPosition = "bottom" | "left" | "right" | "top";

interface TracrDevToolsProps {
  children: ReactNode;
  initialPosition?: DevToolsPosition;
  initialOpen?: boolean;
}

const devtoolClass: Record<DevToolsPosition, string> = {
  bottom: "tracr-devtools-bottom",
  left: "tracr-devtools-left",
  right: "tracr-devtools-right",
  top: "tracr-devtools-top",
};

const NEXT_POSITION: Record<DevToolsPosition, DevToolsPosition> = {
  bottom: "right",
  right: "top",
  top: "left",
  left: "bottom",
};

export const TracrDevTools = ({
  children,
  initialPosition = "bottom",
  initialOpen = false,
}: TracrDevToolsProps) => {
  const [position, setPosition] = useState<DevToolsPosition>(initialPosition);
  const [isOpen, setIsOpen] = useState(initialOpen);

  return (
    <div className={`tracr ${devtoolClass[position]} ${isOpen ? "open" : ""}`}>
      <div className="tracr-inner">
        <div className="toolbar">
          <p>Tracr</p>
          <div>
            <button
              className="tracr-button tracr-button-outline"
              onClick={() => setPosition(NEXT_POSITION[position])}
            >
              move
            </button>
            <button
              className="tracr-button tracr-button-destructive"
              onClick={() => setIsOpen((open) => !open)}
            >
              {isOpen ? "close" : "open"}
            </button>
          </div>
        </div>
        <div className="canvas">{children}</div>
      </div>
    </div>
  );
};
