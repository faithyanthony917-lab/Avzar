import { lpFont } from '../../app/fonts';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';

/** Frame for Terms, Privacy, Contact and Help: public header, readable column, public footer. */
export function InfoPage({ children }: { children: React.ReactNode }) {
  return (
    <div className={`lp ${lpFont.variable}`}>
      <PublicHeader />
      <main className="wrap lp-doc">{children}</main>
      <PublicFooter />
    </div>
  );
}
