import { lpFont } from '../fonts';
import { BrandLogo } from '@/components/BrandLogo';
import '../app.css';

export default function UnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`ap ${lpFont.variable}`}>
      <header className="ap-authbar">
        <BrandLogo href="/" />
        <span className="ap-foot">Message preferences</span>
      </header>
      {children}
    </div>
  );
}
