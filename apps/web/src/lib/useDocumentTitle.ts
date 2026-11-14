import { useEffect } from "react";

/** Sets the document title while the component is mounted (audit b8-web-layout-14). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
