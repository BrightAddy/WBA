import { useMemo, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";
import type { ImageDto } from "@kiosk/shared";

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Product photo: ThumbHash blur paints instantly, the right width loads over it. */
export function Thumb({
  image,
  sizes,
  alt = "",
  className = "",
}: {
  image: ImageDto;
  sizes: string;
  alt?: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const placeholder = useMemo(() => {
    try {
      return image.thumbhash ? thumbHashToDataURL(decode(image.thumbhash)) : undefined;
    } catch {
      return undefined;
    }
  }, [image.thumbhash]);
  const widths = Object.keys(image.urls).map(Number).sort((a, b) => a - b);
  const srcSet = widths.map((w) => `${image.urls[w]} ${w}w`).join(", ");

  return (
    <div
      className={`overflow-hidden bg-sunken bg-cover bg-center ${className}`}
      style={placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}
    >
      <img
        src={image.urls[widths[0]!]}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
