export type OtisAvatarState = "idle" | "thinking" | "talking" | "listening";

interface OtisAvatarProps {
  state: OtisAvatarState;
  message?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const AVATAR_SRC = `${import.meta.env.BASE_URL}images/otis-avatar.png`;

const SIZE_CLASSES: Record<NonNullable<OtisAvatarProps["size"]>, string> = {
  sm: "h-12 w-12",
  md: "h-[120px] w-[120px]",
  lg: "h-[220px] w-[220px] max-md:h-[160px] max-md:w-[160px]",
};

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const CAROLINA = "#56A0D3";
const NAVY = "#0D2B45";

function ThinkingDots() {
  return (
    <span className="inline-flex items-end gap-1.5" aria-label="Otis is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-2 w-2 rounded-full"
          style={{
            backgroundColor: CAROLINA,
            animation: "otis-dot-bounce 1s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}

export function OtisAvatar({ state, message, size = "md", className }: OtisAvatarProps) {
  // sm is a static portrait — no animation, ring, or speech bubble.
  if (size === "sm") {
    return (
      <img
        src={AVATAR_SRC}
        alt="Otis"
        className={`${SIZE_CLASSES.sm} shrink-0 rounded-full object-cover ${className ?? ""}`}
      />
    );
  }

  const rotation = state === "thinking" ? -14 : state === "talking" ? 4 : 0;
  const showRing = state === "thinking" || state === "listening" || state === "talking";
  const ringColor = state === "talking" ? NAVY : CAROLINA;
  const ringPulses = state === "thinking" || state === "listening";
  const bubbleVisible = state === "thinking" || (state === "talking" && !!message);
  const bubbleText = message && message.length > 60 ? `${message.slice(0, 60)}…` : message;

  return (
    <div className={`relative inline-flex flex-col items-center ${className ?? ""}`}>
      {/* Speech bubble */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-3 -translate-x-1/2"
        style={{ opacity: bubbleVisible ? 1 : 0, transition: "opacity 0.3s ease" }}
        aria-hidden={!bubbleVisible}
      >
        <div
          className="relative max-w-[280px] whitespace-nowrap rounded-2xl px-4 py-2.5 text-[13px] font-medium text-white"
          style={{ backgroundColor: NAVY, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {state === "thinking" ? <ThinkingDots /> : bubbleText}
          <span
            className="absolute left-1/2 top-full -translate-x-1/2"
            style={{
              width: 0,
              height: 0,
              borderLeft: "7px solid transparent",
              borderRight: "7px solid transparent",
              borderTop: `7px solid ${NAVY}`,
            }}
          />
        </div>
      </div>

      {/* Avatar + status ring */}
      <div className={`relative ${SIZE_CLASSES[size]}`}>
        <span
          className="absolute rounded-full"
          style={{
            inset: "-6px",
            border: `3px solid ${ringColor}`,
            opacity: showRing ? 1 : 0,
            transition: "opacity 0.3s ease, border-color 0.3s ease",
            animation: ringPulses ? "otis-ring-pulse 1s ease-in-out infinite" : "none",
          }}
          aria-hidden="true"
        />
        {state === "listening" ? (
          // Head-only tilt while the user is typing: the photo is split into a
          // static body layer (bottom) and a head layer (top) that gently rocks
          // side to side around the bottom center of the head region.
          <div className="relative h-full w-full">
            <img
              src={AVATAR_SRC}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full rounded-full object-cover"
              style={{ clipPath: "inset(52% 0 0 0)" }}
            />
            <img
              src={AVATAR_SRC}
              alt="Otis"
              className="absolute inset-0 h-full w-full rounded-full object-cover"
              style={{
                clipPath: "inset(0 0 44% 0)",
                transformOrigin: "50% 56%",
                animation: "otis-head-tilt 2.4s ease-in-out infinite",
              }}
            />
          </div>
        ) : (
          <img
            src={AVATAR_SRC}
            alt="Otis"
            className="h-full w-full rounded-full object-cover"
            style={{
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "center 60%",
              transition: `transform 0.6s ${SPRING}`,
              animation: state === "idle" ? "otis-breathe 4s ease-in-out infinite" : "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
