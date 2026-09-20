import { AnimatePresence, motion } from 'motion/react';

type FlashValue = string | { tone: 'ok' | 'bad'; text: string } | null;

/** 操作反馈条：卖货/进货/收款/备份/退货这几页都在用，统一在这抖一下、亮一下再消失 */
export function Flash({ value, className = '' }: { value: FlashValue; className?: string }) {
  const item = typeof value === 'string' ? { tone: 'ok' as const, text: value } : value;

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          key={item.text}
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className={`rounded-xl px-5 py-3.5 text-[17px] ${
            item.tone === 'ok' ? 'bg-brand-50 text-brand-900' : 'bg-danger-50 text-danger'
          } ${className}`}
        >
          {item.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
