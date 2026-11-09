/* A person's face. The demo's staff are fictional, so in demo mode each one gets a real stock photo
   (Unsplash License, credited in CREDITS.md; the names are invented and do not describe the people pictured).
   Anyone not in the map, live users and attendee-list people included, gets clean initials. A live desk
   shows initials until a real login brings real profile pictures. The event page uses this too. */

import { useActor } from "./App";
import { initials } from "./words";

export const PHOTOS: Record<string, string> = {
  "Dan Whitlock": "/avatars/dan-whitlock.jpg",
  "Maya Ortiz": "/avatars/maya-ortiz.jpg",
  "Priya Nair": "/avatars/priya-nair.jpg",
  "Tomas Berg": "/avatars/tomas-berg.jpg",
  "Camille Laurent": "/avatars/camille-laurent.jpg",
  "Jonas Weber": "/avatars/jonas-weber.jpg",
  "Ana Duarte": "/avatars/ana-duarte.jpg",
  "Lucia Mendez": "/avatars/lucia-mendez.jpg",
  "Leo Marsh": "/avatars/leo-marsh.jpg",
  "Sofia Reyes": "/avatars/sofia-reyes.jpg",
  "Kenji Mori": "/avatars/kenji-mori.jpg",
  "Rafael Costa": "/avatars/rafael-costa.jpg",
  "Hannah Cole": "/avatars/hannah-cole.jpg",
  "Marcus Bell": "/avatars/marcus-bell.jpg",
  "Ibrahim Yusuf": "/avatars/ibrahim-yusuf.jpg",
  "Elena Petrova": "/avatars/elena-petrova.jpg",
  "Grace Okafor": "/avatars/grace-okafor.jpg",
  "Zoe Hartley": "/avatars/zoe-hartley.jpg",
  "Noah Fischer": "/avatars/noah-fischer.jpg",
  "Owen Park": "/avatars/owen-park.jpg",
};

export function PersonAvatar({ name, size = 32, className = "", title }: { name: string; size?: number; className?: string; title?: string }) {
  const { demo } = useActor();
  const photo = demo ? PHOTOS[name] : undefined;
  const px = `${size}px`;
  return (
    <span className={`face${photo ? "" : " ini"} ${className}`.trim()} style={{ width: px, height: px, fontSize: Math.round(size * 0.36) }} role="img" aria-label={name} title={title ?? name}>
      {photo ? <img src={photo} alt="" width={size} height={size} loading="lazy" decoding="async" /> : initials(name)}
    </span>
  );
}
