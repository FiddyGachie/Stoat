import React from "react";
import { Inbox, LucideIcon } from "lucide-react";

/** Small presentational building blocks shared by every screen. Styling lives in layout.css. */

export function Icon({ icon: Glyph, label }: { icon: LucideIcon; label?: string }) {
  // Decorative unless a label is supplied, so screen readers do not announce icon noise.
  return label ? (
    <Glyph className="icon" role="img" aria-label={label} />
  ) : (
    <Glyph className="icon" aria-hidden="true" focusable="false" />
  );
}

/** Google Material Symbol / Icon renderer */
export function MaterialIcon({
  name,
  label,
  className = "",
}: {
  name: string;
  label?: string;
  className?: string;
}) {
  return label ? (
    <span className={`material-symbols-outlined ${className}`.trim()} role="img" aria-label={label}>
      {name}
    </span>
  ) : (
    <span className={`material-symbols-outlined ${className}`.trim()} aria-hidden="true">
      {name}
    </span>
  );
}

/** Glassmorphic brand emblem with matching commerce identity */
export function BrandLogo({ className = "", size = 40 }: { className?: string; size?: number }) {
  return (
    <span
      className={`brand-logo ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img
        src="/favicon.svg"
        alt=""
        width={Math.round(size * 0.7)}
        height={Math.round(size * 0.7)}
        style={{ display: "block" }}
      />
    </span>
  );
}

/** Digital commerce adaptive showcase hero */
export function CommerceHeroCard({
  title,
  subtitle,
  badgeText = "Verified Commerce",
  action,
}: {
  title: string;
  subtitle: string;
  badgeText?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card card--interactive commerce-hero-card">
      <div className="commerce-hero-content">
        <div className="commerce-badge">
          <span className="material-symbols-outlined" aria-hidden="true">verified_user</span>
          <span>{badgeText}</span>
        </div>
        <h2 className="commerce-hero-title">{title}</h2>
        <p className="card-sub">{subtitle}</p>
        {action && <div style={{ marginTop: "var(--space-3)" }}>{action}</div>}
      </div>
      <div className="commerce-hero-visual" aria-hidden="true">
        <img src="/stoat-brand-badge.svg" alt="" width={100} height={100} />
      </div>
    </div>
  );
}

export function PageHeader({
  icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 id="page-title" tabIndex={-1}>
          <Icon icon={icon} />
          {title}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="help-links">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  icon,
  description,
  actions,
  className = "",
  children,
}: {
  title?: string;
  icon?: LucideIcon;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && (
              <h2 className="card-title">
                {icon && <Icon icon={icon} />}
                {title}
              </h2>
            )}
            {description && <p className="card-sub">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: LucideIcon;
  tone?: "success" | "danger" | "warning";
}) {
  return (
    <div className="card">
      <div className="stat">
        <div>
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
          {sub && <div className="stat-sub">{sub}</div>}
        </div>
        <span className={`stat-icon ${tone ? `tone-${tone}` : ""}`.trim()}>
          <Icon icon={icon} />
        </span>
      </div>
    </div>
  );
}

export function EmptyState({
  icon = Inbox,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <Icon icon={icon} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
