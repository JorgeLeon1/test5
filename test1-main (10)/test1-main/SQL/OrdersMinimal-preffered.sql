CREATE TABLE Orders_1 (
    id INT IDENTITY(1,1) PRIMARY KEY,
    customer_id INT NOT NULL,
    facility_id INT NOT NULL,
    reference_num VARCHAR(255),
    notes TEXT,
    shipping_notes TEXT,
    billing_code VARCHAR(50),
    carrier VARCHAR(50),
    mode VARCHAR(10),
    scac_code VARCHAR(10),
    account VARCHAR(50),
    shipto_company_name VARCHAR(255),
    shipto_name VARCHAR(255),
    shipto_address1 VARCHAR(255),
    shipto_address2 VARCHAR(255),
    shipto_city VARCHAR(100),
    shipto_state VARCHAR(50),
    shipto_zip VARCHAR(20),
    shipto_country VARCHAR(10)
);

CREATE TABLE OrderItems (
    id INT IDENTITY(1,1) PRIMARY KEY,
    order_id INT REFERENCES Orders_1(id),
    sku VARCHAR(100) NOT NULL,
    qty INT NOT NULL
);


CREATE TABLE Inventory (
    CustomerName VARCHAR(100) NOT NULL,
    CustomerID INT NOT NULL,
    ReceiverId INT NOT NULL,
    ReceiveDate DATE NOT NULL,
    ReceiveItemID INT NOT NULL PRIMARY KEY,
    ItemID INT NOT NULL,
    SKU VARCHAR(50) NOT NULL,
    UnitID INT NOT NULL,
    UnitName VARCHAR(50) NOT NULL,
    Qualifier VARCHAR(50),
    LocationName VARCHAR(100) NOT NULL,
    LocationID INT NOT NULL,
    PalletName VARCHAR(100),
    PalletID INT,
    ReceivedQTY DECIMAL(10, 4) NOT NULL,
    OnHandQTY DECIMAL(10, 4) NOT NULL,
    AvailableQTY DECIMAL(10, 4) NOT NULL,
);

CREATE TABLE OrderDetails (
    OrderID INT NOT NULL,
    OrderItemID INT NOT NULL PRIMARY KEY,
    CustomerName VARCHAR(100),
    CustomerID INT NOT NULL,
    ItemID INT NOT NULL,
    SKU VARCHAR(50) NOT NULL,
    UnitID INT NOT NULL,
    UnitName VARCHAR(50) NOT NULL,
    Qualifier VARCHAR(50),
    OrderedQTY DECIMAL(10, 4) NOT NULL,
    ReferenceNum VARCHAR(50),
    ShipToAddress VARCHAR(255),
);

CREATE TABLE OrderDetails (
    OrderID INT NOT NULL,
    OrderItemID INT NOT NULL PRIMARY KEY,
    CustomerName VARCHAR(100),
    CustomerID INT NOT NULL,
    ItemID INT NOT NULL,
    SKU VARCHAR(50) NOT NULL,
    UnitID INT NOT NULL,
    UnitName VARCHAR(50) NOT NULL,
    Qualifier VARCHAR(50),
    OrderedQTY DECIMAL(10, 4) NOT NULL,
    ReferenceNum VARCHAR(50),
    ShipToAddress VARCHAR(255),
);

-- Insert sample data from provided JSON
INSERT INTO OrderDetails (
    OrderID, OrderItemID, CustomerName, CustomerID, ItemID, SKU, 
    UnitID, UnitName, Qualifier, OrderedQTY, ReferenceNum, ShipToAddress
)
VALUES 
(208127, 354954, 'Jool Baby', 47, 8054, 'PT-QF-1-WT-LNG', 1, 'Each', '', 275.0000, 'FBA18Z6TY6BJ', 'Amazon.com, 255 Park Center Drive, Patterson, CA 95363-8876, US'),
(208127, 354955, 'Jool Baby', 47, 8257, 'DP-CPAD-2-GY', 1, 'Each', '', 24.0000, 'FBA18Z6TY6BJ', 'Amazon.com, 255 Park Center Drive, Patterson, CA 95363-8876, US');
