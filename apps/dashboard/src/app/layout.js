import './globals.css';

export const metadata = {
  title: 'Collecte des taxes locales',
  description: 'Tableau de bord de la commune — plateforme de collecte des taxes locales',
  robots: 'noindex, nofollow',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0B5D2B' },
    { media: '(prefers-color-scheme: dark)', color: '#1A1A19' },
  ],
};

export default function RacineLayout({ children }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/*
          Le thème est appliqué AVANT le premier rendu : sans ce script, un
          utilisateur en mode sombre verrait un éclair blanc à chaque page.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('gtfc-theme');
              if(t){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-plan text-encre antialiased">{children}</body>
    </html>
  );
}
