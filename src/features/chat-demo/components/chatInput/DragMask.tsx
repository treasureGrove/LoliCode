import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { MAX_COUNT, MAX_SIZE_MB } from '../../services/attachments.js'
import styles from './DragMask.module.css'

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

/**
 * 拖拽上传：页面任意位置拖入文件即显示全屏遮罩，松手后交给 onDrop。
 */
export const useFileDrop = (onDrop: (files: File[]) => void) => {
  const [dragging, setDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  useEffect(() => {
    // dragenter / dragleave 会在子元素间反复触发，用计数判断是否真正离开页面
    let depth = 0
    const enter = (event: DragEvent) => {
      if (hasFiles(event)) {
        depth++
        setDragging(true)
      }
    }
    const leave = (event: DragEvent) => {
      if (hasFiles(event) && --depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const over = (event: DragEvent) => {
      if (hasFiles(event)) {
        event.preventDefault()
      }
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return
      }
      event.preventDefault()
      depth = 0
      setDragging(false)
      onDropRef.current(Array.from(event.dataTransfer?.files ?? []))
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('dragover', over)
      document.removeEventListener('drop', drop)
    }
  }, [])
  return dragging
}

/** 拖拽遮罩，挂到 body 上盖住整个页面 */
export const DragMask = () => createPortal(<DragMaskContent />, document.body)

const DragMaskContent = () => {
  const t = useTranslate()
  return (
    <div className={styles.mask}>
      <div className={styles.wrap}>
        <UploadIcon />
        <div className={styles.title}>{t('dragFileToUpload')}</div>
        <div className={styles.desc}>
          {t('dragFileDesc', { count: MAX_COUNT, size: MAX_SIZE_MB })}
        </div>
      </div>
    </div>
  )
}

const UploadIcon = () => {
  return (
    <svg
      width="115"
      height="84"
      viewBox="0 0 115 84"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#uploadIconClipPath)">
        <rect
          y="17.0742"
          width="44.1832"
          height="43.6431"
          rx="12"
          transform="rotate(-22.7338 0 17.0742)"
          fill="#9CE5ED"
        />
        <rect
          x="73.4043"
          y="8.54297"
          width="43.7267"
          height="50.5284"
          rx="8"
          transform="rotate(17.403 73.4043 8.54297)"
          fill="#679EFE"
        />
        <rect
          x="73.4043"
          y="8.54297"
          width="43.7267"
          height="50.5284"
          rx="8"
          transform="rotate(17.403 73.4043 8.54297)"
          fill="#679EFE"
        />
        <path
          d="M30.4917 28.1369L40.8865 33.4564L37.2232 34.9524L29.5302 31.0159L26.7919 39.2122L23.1285 40.7082L26.8287 29.6338L16.8967 24.5516L20.5601 23.0556L27.7902 26.7549L30.3639 19.052L34.0273 17.556L30.4917 28.1369Z"
          fill="white"
        />
        <path d="M77.5088 26.3047L101.057 33.7966" stroke="white" strokeWidth="3" />
        <path d="M72.2646 42.7871L86.3938 47.2823" stroke="white" strokeWidth="3" />
        <path d="M74.8867 34.5469L98.4353 42.0388" stroke="white" strokeWidth="3" />
        <rect
          x="31.583"
          y="38.6641"
          width="44.9157"
          height="44.3666"
          rx="12"
          transform="rotate(-0.134233 31.583 38.6641)"
          fill="#3964FE"
        />
        <path
          d="M38.9521 73.0337C39.6129 71.7086 41.7113 66.0937 43.5113 61.1663C44.1607 59.3885 46.7484 59.3923 47.4591 61.1465C48.9728 64.8828 50.7969 68.6922 51.9988 69.1925C54.2946 70.1482 57.9854 59.3573 68.0064 70.1801"
          stroke="white"
          strokeWidth="3"
        />
        <circle
          cx="60.6157"
          cy="52.247"
          r="4.38794"
          transform="rotate(22.5996 60.6157 52.247)"
          fill="white"
        />
      </g>
      <defs>
        <clipPath id="uploadIconClipPath">
          <rect width="115" height="84" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}
