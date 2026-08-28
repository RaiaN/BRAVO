import Head from 'next/head';
import '../styles/globals.css';

export default function BravoApp({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>BRAVO</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
