import { companyDisplayName } from '../shared/company-display-name';
import type { TeamStats } from '../shared/team-metrics';
import { TeamTablePagination, useTeamTablePage } from './TeamTablePagination';

export function InactiveCompanies({ stats }: { stats: TeamStats[] }) {
  const companies = stats.flatMap((employee) =>
    employee.inactiveCompanies.map((company) => ({ ...company, ownerName: employee.name })),
  );
  const { tableRef, visibleRows, pagination } = useTeamTablePage(companies);

  return (
    <section className="team-overview pico-team-inactive" aria-labelledby="team-inactive-title">
      <div className="team-overview-head">
        <h2 id="team-inactive-title">Нет контакта 14 дней</h2>
      </div>
      {companies.length ? (
        <>
          <table
            ref={tableRef}
            tabIndex={-1}
            aria-labelledby="team-inactive-title"
            className="team-table team-inactive-table"
          >
            <thead>
              <tr>
                <th scope="col">Компания</th>
                <th scope="col">Ответственный</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((company) => (
                <tr key={company.id}>
                  <th scope="row">{companyDisplayName(company.name)}</th>
                  <td>{company.ownerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TeamTablePagination {...pagination} />
        </>
      ) : (
        <p className="team-overview-note">Таких компаний нет.</p>
      )}
    </section>
  );
}
