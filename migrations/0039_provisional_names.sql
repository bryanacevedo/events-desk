-- A company known only from a work email's domain carries a label made from the domain until a data source gives its real name.
ALTER TABLE companies ADD COLUMN name_provisional boolean NOT NULL DEFAULT false;
