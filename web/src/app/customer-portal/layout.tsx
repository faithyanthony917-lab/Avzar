import { lpFont } from '../fonts';
import { BrandLogo } from '@/components/BrandLogo';
import { Toaster } from '@/components/app/Toaster';
import '../app.css';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`ap ${lpFont.variable}`}>
      <header className="ap-authbar">
        <BrandLogo href="/" />
        <span className="ap-foot">Customer portal</span>
      </header>
      {children}
      <Toaster />
    </div>
  );
}
