import { Button } from '@ui/components/Button'
import styles from './AgentImageGallery.module.css'

export interface AgentPreviewImage {
  id: string
  src: string
  alt: string
  title?: string
}

interface AgentImageGalleryProps {
  images: AgentPreviewImage[]
  label: string
  onOpenImage(image: AgentPreviewImage): void
}

/** Compact, shared gallery for user, assistant, and browser-tool images. */
export function AgentImageGallery({ images, label, onOpenImage }: AgentImageGalleryProps) {
  if (images.length === 0) return null

  return (
    <div
      className={styles.gallery}
      data-count={Math.min(images.length, 3)}
      role="group"
      aria-label={label}
    >
      {images.map((image) => (
        <Button
          key={image.id}
          type="button"
          variant="ghost"
          size="sm"
          shape="flush"
          aria-label={`Open image preview: ${image.alt}`}
          aria-haspopup="dialog"
          className={styles.thumbnailButton}
          onClick={() => onOpenImage(image)}
        >
          <img
            src={image.src}
            alt={image.alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className={styles.thumbnail}
          />
        </Button>
      ))}
    </div>
  )
}
