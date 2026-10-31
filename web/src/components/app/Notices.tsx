export function NoAccess() {
  return <div className="ap-panel" role="alert"><p style={{ margin: 0 }}>You do not have permission to view this page. Ask the business owner to change your role.</p></div>;
}

export function LoadError({ status }: { status: number }) {
  return (
    <div className="ap-panel" role="alert">
      <p style={{ margin: 0 }}>{status === 403 ? 'You do not have permission to view this page.' : 'This page could not be loaded. Reload to try again.'}</p>
    </div>
  );
}
