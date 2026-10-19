-- Events read from an uploaded file keep the file they came from: deleting the document removes
-- them with it (a cascade passes the immutability trigger), so a wrong file can be taken back
-- whole and loaded again.
alter table public.events add column document_id uuid;
alter table public.events add constraint events_document_fkey
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade;
create index events_document on public.events (document_id) where document_id is not null;
