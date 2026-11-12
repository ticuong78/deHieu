'use client';

import type { ReactNode } from 'react';
import { AlertDialog, Dialog, VisuallyHidden } from 'radix-ui';
import { Drawer } from 'vaul';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-media';
import { Button } from './button';

interface PanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Dòng nhỏ phía trên tiêu đề. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  width?: 'md' | 'lg' | 'xl';
}

/**
 * Chi tiết dạng drawer phải (desktop) ↔ bottom sheet có tay nắm (mobile).
 * Desktop không phủ nền: danh sách bên trái vẫn bấm được để chuyển sang mục khác.
 */
export function Panel(p: PanelProps) {
  const mobile = useIsMobile();
  return mobile ? <MobileSheet {...p} /> : <DesktopDrawer {...p} />;
}

function Head({ eyebrow, title, description, actions }: Pick<PanelProps, 'eyebrow' | 'title' | 'description' | 'actions'>) {
  return (
    <div className="min-w-0 flex-1">
      {eyebrow ? <div className="mb-1.5 text-caption text-muted-fg">{eyebrow}</div> : null}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-[17px] font-semibold leading-6 tracking-tight text-fg [overflow-wrap:anywhere]">{title}</div>
        {actions}
      </div>
      {description ? <div className="mt-1 text-body text-muted-fg">{description}</div> : null}
    </div>
  );
}

function DesktopDrawer({ open, onOpenChange, title, eyebrow, description, actions, footer, children, width = 'md' }: PanelProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'fixed inset-y-0 right-0 z-40 flex flex-col bg-raised shadow-pop outline-none',
            'data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
            width === 'xl' ? 'w-[min(920px,100vw)]' : width === 'lg' ? 'w-[min(640px,100vw)]' : 'w-[min(480px,100vw)]',
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-6 pb-4 pt-5">
            <Dialog.Title asChild>
              <div className="min-w-0 flex-1">
                <Head eyebrow={eyebrow} title={title} description={description} actions={actions} />
              </div>
            </Dialog.Title>
            <VisuallyHidden.Root>
              <Dialog.Description>Bảng chi tiết</Dialog.Description>
            </VisuallyHidden.Root>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Đóng" className="-mr-2 -mt-0.5">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MobileSheet({ open, onOpenChange, title, eyebrow, description, actions, footer, children }: PanelProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[94dvh] flex-col rounded-t-[14px] bg-raised shadow-pop outline-none">
          <div className="mx-auto mb-1 mt-2.5 h-1 w-9 shrink-0 rounded-full bg-line-strong" aria-hidden />
          <div className="flex items-start gap-3 px-4 pb-3 pt-2">
            <Drawer.Title asChild>
              <div className="min-w-0 flex-1">
                <Head eyebrow={eyebrow} title={title} description={description} actions={actions} />
              </div>
            </Drawer.Title>
            <VisuallyHidden.Root>
              <Drawer.Description>Bảng chi tiết</Drawer.Description>
            </VisuallyHidden.Root>
            <Drawer.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Đóng" className="-mr-2 size-11">
                <X />
              </Button>
            </Drawer.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">{children}</div>
          {footer ? <div className="flex items-center gap-2 border-t border-line px-4 py-3 pb-safe [&>*]:flex-1">{footer}</div> : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** Bottom sheet thuần (mobile) hoặc hộp thoại giữa (desktop) cho nội dung ngắn: nhắc bật thông báo, hướng dẫn cài… */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const mobile = useIsMobile();
  if (mobile)
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-50 bg-scrim" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-[14px] bg-raised outline-none">
            <div className="mx-auto mb-2 mt-2.5 h-1 w-9 rounded-full bg-line-strong" aria-hidden />
            <div className="overflow-y-auto px-5 pb-4 pt-2">
              <Drawer.Title className="mb-2 text-[17px] font-semibold tracking-tight text-fg">{title}</Drawer.Title>
              <Drawer.Description asChild>
                <div className="text-body text-muted-fg">{children}</div>
              </Drawer.Description>
            </div>
            {footer ? <div className="flex flex-col gap-2 px-5 pb-safe pt-2 [&>*]:h-11 [&>*]:w-full mb-4">{footer}</div> : null}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[18vh] z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-[10px] bg-raised p-6 shadow-pop outline-none animate-pop-in">
          <Dialog.Title className="mb-2 text-[17px] font-semibold tracking-tight text-fg">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="text-body text-muted-fg">{children}</div>
          </Dialog.Description>
          {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Hộp xác nhận cho thao tác có hậu quả (dừng publisher, tạo bí danh, lưu cài đặt…).
 * Mobile: hiện dạng bottom sheet với nút lớn.
 */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Xác nhận',
  confirmDisabled = false,
  tone = 'primary',
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
}) {
  const mobile = useIsMobile();
  const buttons = (
    <>
      <Button variant="ghost" onClick={() => onOpenChange(false)} size={mobile ? 'lg' : 'md'}>
        Hủy
      </Button>
      <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} disabled={confirmDisabled} size={mobile ? 'lg' : 'md'}>
        {confirmLabel}
      </Button>
    </>
  );
  if (mobile)
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-50 bg-scrim" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] bg-raised px-5 pb-safe outline-none">
            <div className="mx-auto mb-3 mt-2.5 h-1 w-9 rounded-full bg-line-strong" aria-hidden />
            <Drawer.Title className="text-[17px] font-semibold tracking-tight text-fg">{title}</Drawer.Title>
            <Drawer.Description className="mt-1.5 text-body text-muted-fg">{description}</Drawer.Description>
            {children ? <div className="mt-4">{children}</div> : null}
            <div className="mb-4 mt-6 flex flex-col-reverse gap-2 [&>*]:w-full">{buttons}</div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in" />
        <AlertDialog.Content className="fixed left-1/2 top-[20vh] z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 rounded-[10px] bg-raised p-6 shadow-pop outline-none animate-pop-in">
          <AlertDialog.Title className="text-[17px] font-semibold tracking-tight text-fg">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-body text-muted-fg">{description}</AlertDialog.Description>
          {children ? <div className="mt-5">{children}</div> : null}
          <div className="mt-6 flex justify-end gap-2">{buttons}</div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
