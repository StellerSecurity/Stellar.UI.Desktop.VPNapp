// Deterministic local artwork: no downloaded textures, network requests or timers.
const stars = Array.from({ length: 190 }, (_, index) => {
  const seed = (index + 1) * 2654435761 >>> 0;
  return { x: seed % 1200, y: ((seed ^ seed >>> 13) >>> 0) % 800,
    radius: index % 19 === 0 ? 1.25 : index % 5 === 0 ? .8 : .45,
    opacity: .22 + (seed % 53) / 100 };
});
export function SpaceBackground() {
  return <div className="map-space" aria-hidden="true">
    <svg viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" className="map-stars">
      {stars.map((star, index) => <circle key={index} cx={star.x} cy={star.y} r={star.radius} fill={index % 7 === 0 ? '#a6b8ec' : '#fff'} opacity={star.opacity} />)}
    </svg>
  </div>;
}
